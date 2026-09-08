import { sha256 } from '../../../../shared/sha256'
import type { DiffComment, MobileDiffReviewState } from '../../../../shared/diff-comment-types'
import type { RuntimeWorktreeRecord } from '../../../../shared/runtime-worktree-contracts'
import {
  MOBILE_WEB_REVIEW_COMMENT_LIMIT,
  MOBILE_WEB_REVIEW_COMMENT_MAX_CHARACTERS,
  MOBILE_WEB_REVIEW_FILE_STATE_LIMIT,
  MobileWebSourceControlReviewLinkResultSchema,
  MobileWebSourceControlReviewMetadataResultSchema,
  type MobileWebSourceControlReviewComment,
  type MobileWebSourceControlReviewState
} from '../../../../shared/mobile-web/source-control-review-contract'

export function projectMobileWebReviewMetadata(worktree: RuntimeWorktreeRecord) {
  const rawComments = worktree.diffComments ?? []
  const rawFiles = Object.values(worktree.mobileDiffReview?.files ?? {})
  if (
    rawComments.length > MOBILE_WEB_REVIEW_COMMENT_LIMIT ||
    rawFiles.length > MOBILE_WEB_REVIEW_FILE_STATE_LIMIT
  ) {
    throw new Error('too_large')
  }
  const comments = rawComments.map(projectComment)
  const reviewState: MobileWebSourceControlReviewState = {
    version: 1,
    ...(worktree.mobileDiffReview?.updatedAt === undefined
      ? {}
      : { updatedAt: worktree.mobileDiffReview.updatedAt }),
    ...(worktree.mobileDiffReview?.completedAt === undefined
      ? {}
      : { completedAt: worktree.mobileDiffReview.completedAt }),
    files: rawFiles.map((file) => ({
      key: file.key,
      relativePath: file.filePath,
      ...(file.oldPath ? { oldRelativePath: file.oldPath } : {}),
      scope: file.scope,
      ...(file.lastOpenedAt === undefined ? {} : { lastOpenedAt: file.lastOpenedAt }),
      ...(file.lastSeenDiffIdentity ? { lastSeenDiffIdentity: file.lastSeenDiffIdentity } : {}),
      ...(file.reviewedAt === undefined ? {} : { reviewedAt: file.reviewedAt }),
      ...(file.reviewDiffIdentity ? { reviewDiffIdentity: file.reviewDiffIdentity } : {})
    }))
  }
  const { workspaceId: _workspaceId, ...projected } =
    MobileWebSourceControlReviewMetadataResultSchema.parse({
      workspaceId: 'page',
      revision: mobileWebReviewMetadataRevision({ comments, reviewState }),
      comments,
      reviewState
    })
  return projected
}

export function mobileWebReviewMetadataRevision(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(value))), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

/** The only workspace fields a review write may touch. */
export function mobileWebReviewMetadataWorktreeFields(args: {
  worktreeId: string
  comments: readonly MobileWebSourceControlReviewComment[]
  reviewState: MobileWebSourceControlReviewState
}): { diffComments: DiffComment[]; mobileDiffReview: MobileDiffReviewState } {
  return {
    diffComments: args.comments.map((comment) => ({
      id: comment.id,
      worktreeId: args.worktreeId,
      filePath: comment.relativePath,
      ...(comment.oldRelativePath ? { oldPath: comment.oldRelativePath } : {}),
      ...(comment.source ? { source: comment.source } : {}),
      ...(comment.selectedText === undefined ? {} : { selectedText: comment.selectedText }),
      ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
      lineNumber: comment.lineNumber,
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      ...(comment.sentAt === undefined ? {} : { sentAt: comment.sentAt }),
      ...(comment.scope ? { scope: comment.scope } : {}),
      ...(comment.diffIdentity ? { diffIdentity: comment.diffIdentity } : {}),
      side: 'modified'
    })),
    mobileDiffReview: {
      version: 1,
      ...(args.reviewState.updatedAt === undefined
        ? {}
        : { updatedAt: args.reviewState.updatedAt }),
      ...(args.reviewState.completedAt === undefined
        ? {}
        : { completedAt: args.reviewState.completedAt }),
      files: Object.fromEntries(
        args.reviewState.files.map((file) => [
          file.key,
          {
            key: file.key,
            filePath: file.relativePath,
            ...(file.oldRelativePath ? { oldPath: file.oldRelativePath } : {}),
            scope: file.scope,
            ...(file.lastOpenedAt === undefined ? {} : { lastOpenedAt: file.lastOpenedAt }),
            ...(file.lastSeenDiffIdentity
              ? { lastSeenDiffIdentity: file.lastSeenDiffIdentity }
              : {}),
            ...(file.reviewedAt === undefined ? {} : { reviewedAt: file.reviewedAt }),
            ...(file.reviewDiffIdentity ? { reviewDiffIdentity: file.reviewDiffIdentity } : {})
          }
        ])
      )
    }
  }
}

export function projectMobileWebReviewLink(worktree: RuntimeWorktreeRecord) {
  const { workspaceId: _workspaceId, ...projected } =
    MobileWebSourceControlReviewLinkResultSchema.parse({
      workspaceId: 'page',
      baseRef: worktree.baseRef ? worktree.baseRef.slice(0, 512) : null,
      linkedGitHubPR: positiveInteger(worktree.linkedPR),
      linkedGitLabMR: positiveInteger(worktree.linkedGitLabMR),
      linkedBitbucketPR: positiveInteger(worktree.linkedBitbucketPR),
      linkedAzureDevOpsPR: positiveInteger(worktree.linkedAzureDevOpsPR),
      linkedGiteaPR: positiveInteger(worktree.linkedGiteaPR)
    })
  return projected
}

export function mobileWebReviewLinkWorktreeField(
  provider: 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea',
  number: number | null
) {
  if (provider === 'github') {
    return { linkedPR: number }
  }
  if (provider === 'gitlab') {
    return { linkedGitLabMR: number }
  }
  if (provider === 'bitbucket') {
    return { linkedBitbucketPR: number }
  }
  if (provider === 'azure-devops') {
    return { linkedAzureDevOpsPR: number }
  }
  return { linkedGiteaPR: number }
}

function projectComment(comment: DiffComment): MobileWebSourceControlReviewComment {
  return {
    id: comment.id,
    relativePath: comment.filePath,
    ...(comment.oldPath ? { oldRelativePath: comment.oldPath } : {}),
    ...(comment.source ? { source: comment.source } : {}),
    ...(comment.selectedText === undefined
      ? {}
      : { selectedText: comment.selectedText.slice(0, MOBILE_WEB_REVIEW_COMMENT_MAX_CHARACTERS) }),
    ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
    lineNumber: comment.lineNumber,
    body: comment.body.slice(0, MOBILE_WEB_REVIEW_COMMENT_MAX_CHARACTERS),
    createdAt: comment.createdAt,
    ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
    ...(comment.sentAt === undefined ? {} : { sentAt: comment.sentAt }),
    ...(comment.scope ? { scope: comment.scope } : {}),
    ...(comment.diffIdentity ? { diffIdentity: comment.diffIdentity } : {}),
    side: 'modified'
  }
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}
