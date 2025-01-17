import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { eq, sql, desc, and, InferSelectModel, isNotNull } from "drizzle-orm";
import * as schema from "@/lib/schema";
import { getUser, isAdmin } from "../user";
import { DID } from "../atproto/did";
import * as atprotoComment from "../atproto/comment";
import { Prettify } from "@/lib/utils";
import {
  deleteCommentAggregateTrigger,
  newCommentAggregateTrigger,
} from "./triggers";

type CommentRow = InferSelectModel<typeof schema.Comment>;

type CommentExtras = {
  children?: CommentModel[];
  userHasVoted: boolean;
  // These properties are returned from some methods but not others
  rank: number;
  voteCount: number;
  postAuthorDid?: DID;
  postRkey?: string;
};

type LiveComment = CommentRow & CommentExtras & { status: "live" };

type HiddenComment = Omit<CommentRow, "status" | "body"> &
  CommentExtras & {
    status: Exclude<CommentRow["status"], "live">;
    body: null;
  };

export type CommentModel = Prettify<LiveComment | HiddenComment>;

const buildUserHasVotedQuery = cache(async () => {
  const user = await getUser();

  return db
    .select({
      commentId: schema.CommentVote.commentId,
      // This is not entirely type safe but there isn't a better way to do this in drizzle right now
      userHasVoted: sql<boolean>`${isNotNull(schema.CommentVote.commentId)}`.as(
        "userHasVoted",
      ),
    })
    .from(schema.CommentVote)
    .where(user ? eq(schema.CommentVote.authorDid, user.did) : sql`false`)
    .as("hasVoted");
});

//TODO: implement banned user query for comments

// const bannedUserSubQuery = db
//   .select({
//     did: schema.LabelledProfile.did,
//     isHidden: schema.LabelledProfile.isHidden,
//   })
//   .from(schema.LabelledProfile)
//   .as("bannedUser");

export const getCommentsForPost = cache(async (postId: number) => {
  const hasVoted = await buildUserHasVotedQuery();

  const rows = await db
    .select({
      id: schema.Comment.id,
      rkey: schema.Comment.rkey,
      cid: schema.Comment.cid,
      postId: schema.Comment.postId,
      body: schema.Comment.body,
      createdAt: schema.Comment.createdAt,
      authorDid: schema.Comment.authorDid,
      status: schema.Comment.status,
      voteCount: schema.CommentAggregates.voteCount,
      rank: schema.CommentAggregates.rank,
      userHasVoted: hasVoted.userHasVoted,
      parentCommentId: schema.Comment.parentCommentId,
    })
    .from(schema.Comment)
    .where(eq(schema.Comment.postId, postId))
    .innerJoin(
      schema.CommentAggregates,
      eq(schema.Comment.id, schema.CommentAggregates.commentId),
    )
    .leftJoin(hasVoted, eq(hasVoted.commentId, schema.Comment.id))
    .orderBy(desc(schema.CommentAggregates.rank));

  return nestCommentRows(rows);
});

export const getCommentWithChildren = cache(
  async (postId: number, authorDid: DID, rkey: string) => {
    // We're currently fetching all rows from the database, this can be made more efficient later
    const comments = await getCommentsForPost(postId);

    return findCommentSubtree(comments, authorDid, rkey);
  },
);

const nestCommentRows = (
  items: (CommentRow & {
    userHasVoted: boolean;
    voteCount: number;
    rank: number;
  })[],
  id: number | null = null,
): CommentModel[] => {
  const comments: CommentModel[] = [];

  for (const item of items) {
    if (item.parentCommentId !== id) {
      continue;
    }

    const children = nestCommentRows(items, item.id);
    const transformed = {
      userHasVoted: item.userHasVoted !== null,
      voteCount: item.voteCount,
      rank: item.rank,
    };
    if (item.status === "live") {
      comments.push({
        ...item,
        ...transformed,
        // Explicit copy is required to avoid TS error
        status: item.status,
        children,
      });
    } else {
      comments.push({
        ...item,
        ...transformed,
        // Explicit copy is required to avoid TS error
        status: item.status,
        body: null,
        children,
      });
    }
  }

  return comments;
};

const findCommentSubtree = (
  items: CommentModel[],
  authorDid: DID,
  rkey: string,
): CommentModel | null => {
  for (const item of items) {
    if (item.rkey === rkey && item.authorDid === authorDid) {
      return item;
    }

    if (!item.children) return null;

    const child = findCommentSubtree(item.children, authorDid, rkey);
    if (child) {
      return child;
    }
  }

  return null;
};

export const getComment = cache(async (rkey: string) => {
  const rows = await db
    .select()
    .from(schema.Comment)
    .where(eq(schema.Comment.rkey, rkey))
    .limit(1);

  return rows[0] ?? null;
});

export async function uncached_doesCommentExist(rkey: string) {
  const row = await db
    .select({ id: schema.Comment.id })
    .from(schema.Comment)
    .where(eq(schema.Comment.rkey, rkey))
    .limit(1);

  return Boolean(row[0]);
}

export const getUserComments = cache(async (userDid: DID) => {
  const hasVoted = await buildUserHasVotedQuery();
  const comments = await db
    .select({
      id: schema.Comment.id,
      rkey: schema.Comment.rkey,
      cid: schema.Comment.cid,
      postId: schema.Comment.postId,
      body: schema.Comment.body,
      createdAt: schema.Comment.createdAt,
      authorDid: schema.Comment.authorDid,
      status: schema.Comment.status,
      postRkey: schema.Post.rkey,
      postAuthorDid: schema.Post.authorDid,
      parentCommentId: schema.Comment.parentCommentId,
      userHasVoted: hasVoted.userHasVoted,
    })
    .from(schema.Comment)
    .where(
      and(
        eq(schema.Comment.authorDid, userDid),
        eq(schema.Comment.status, "live"),
      ),
    )
    .leftJoin(schema.Post, eq(schema.Comment.postId, schema.Post.id))
    .leftJoin(hasVoted, eq(hasVoted.commentId, schema.Comment.id));

  return comments as LiveComment[];
});

export function shouldHideComment(comment: CommentModel) {
  return (
    comment.status !== "live" &&
    comment.children &&
    comment.children.length === 0
  );
}

type ModerateCommentInput = {
  rkey: string;
  authorDid: DID;
  cid: string;
  hide: boolean;
};
export async function moderateComment({
  rkey,
  authorDid,
  cid,
  hide,
}: ModerateCommentInput) {
  const adminUser = await isAdmin();

  if (!adminUser) {
    throw new Error("User is not an admin");
  }

  console.log(`Moderating comment, setting hidden to ${hide}`);
  await db
    .update(schema.Comment)
    .set({ status: hide ? "moderator_hidden" : "live" })
    .where(
      and(
        eq(schema.Comment.rkey, rkey),
        eq(schema.Comment.authorDid, authorDid),
        eq(schema.Comment.cid, cid),
      ),
    );
}

export type UnauthedCreateCommentInput = {
  cid: string;
  comment: atprotoComment.Comment;
  repo: DID;
  rkey: string;
};

export async function unauthed_createComment({
  cid,
  comment,
  repo,
  rkey,
}: UnauthedCreateCommentInput) {
  await db.transaction(async (tx) => {
    const parentComment =
      comment.parent != null
        ? (
            await tx
              .select()
              .from(schema.Comment)
              .where(eq(schema.Comment.cid, comment.parent.cid))
          )[0]
        : null;

    const post = (
      await tx
        .select()
        .from(schema.Post)
        .where(eq(schema.Post.cid, comment.post.cid))
    )[0];

    if (!post) {
      throw new Error("Post not found");
    }

    if (post.status !== "live") {
      throw new Error(`[naughty] Cannot comment on deleted post. ${repo}`);
    }
    const [insertedComment] = await tx
      .insert(schema.Comment)
      .values({
        cid,
        rkey,
        body: comment.content,
        postId: post.id,
        authorDid: repo,
        createdAt: new Date(comment.createdAt),
        parentCommentId: parentComment?.id ?? null,
      })
      .returning({
        id: schema.Comment.id,
        postId: schema.Comment.postId,
      });

    if (!insertedComment) {
      throw new Error("Failed to insert comment");
    }

    await newCommentAggregateTrigger(
      insertedComment.postId,
      insertedComment.id,
      tx,
    );
  });
}

export type UnauthedDeleteCommentInput = {
  rkey: string;
  repo: DID;
};

export async function unauthed_deleteComment({
  rkey,
  repo,
}: UnauthedDeleteCommentInput) {
  await db.transaction(async (tx) => {
    const [deletedComment] = await tx
      .update(schema.Comment)
      .set({ status: "deleted" })
      .where(
        and(eq(schema.Comment.rkey, rkey), eq(schema.Comment.authorDid, repo)),
      )
      .returning({
        id: schema.Comment.id,
        postId: schema.Comment.postId,
      });

    if (!deletedComment) {
      throw new Error("Failed to delete comment");
    }

    await deleteCommentAggregateTrigger(
      deletedComment.postId,
      deletedComment.id,
      tx,
    );
  });
}
