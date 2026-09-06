import type {
  DiffComment,
  MobileDiffReviewFileState,
  MobileDiffReviewState
} from '../../../src/shared/diff-comment-types'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type {
  MobileWebSourceControlReviewMetadataResult,
  MobileWebSourceControlReviewMetadataUpdatePayload
} from '../../../src/shared/mobile-web/source-control-review-contract'
import { normalizeMobileDiffComments } from './mobile-diff-comments'
import { normalizeMobileDiffReviewState } from './mobile-diff-review-state'

export type WebHostDiffReviewMetadataCache = {
  revision: string | null
}

export async function readWebHostDiffReviewMetadata(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  cache: WebHostDiffReviewMetadataCache
}) {
  const result = await args.client.sourceControlReviewMetadata({
    workspaceId: args.workspaceId
  })
  args.cache.revision = result.revision
  return {
    diffComments: result.comments.map((comment): DiffComment => ({
      id: comment.id,
      worktreeId: args.workspaceId,
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
    mobileDiffReview: reviewStateFromWire(result)
  }
}

export async function updateWebHostDiffReviewMetadata(args: {
  client: MobileWebBridgeClient
  workspaceId: string
  cache: WebHostDiffReviewMetadataCache
  params: Record<string, unknown>
}) {
  if (!args.cache.revision) {
    await readWebHostDiffReviewMetadata(args)
  }
  const payload = reviewMetadataUpdatePayload(
    args.workspaceId,
    args.cache.revision ?? '',
    args.params.diffComments,
    args.params.mobileDiffReview
  )
  const result = await args.client.sourceControlReviewMetadataUpdate(payload)
  args.cache.revision = result.revision
  return { success: true }
}

function reviewMetadataUpdatePayload(
  workspaceId: string,
  expectedRevision: string,
  commentsValue: unknown,
  reviewStateValue: unknown
): MobileWebSourceControlReviewMetadataUpdatePayload {
  const comments = normalizeMobileDiffComments(commentsValue, workspaceId)
  const reviewState = normalizeMobileDiffReviewState(reviewStateValue)
  return {
    workspaceId,
    expectedRevision,
    comments: comments.map((comment) => ({
      id: comment.id,
      relativePath: comment.filePath,
      ...(comment.oldPath ? { oldRelativePath: comment.oldPath } : {}),
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
    reviewState: {
      version: 1,
      ...(reviewState.updatedAt === undefined ? {} : { updatedAt: reviewState.updatedAt }),
      ...(reviewState.completedAt === undefined ? {} : { completedAt: reviewState.completedAt }),
      files: Object.values(reviewState.files).map(fileStateToWire)
    }
  }
}

function reviewStateFromWire(
  result: MobileWebSourceControlReviewMetadataResult
): MobileDiffReviewState {
  return {
    version: 1,
    ...(result.reviewState.updatedAt === undefined
      ? {}
      : { updatedAt: result.reviewState.updatedAt }),
    ...(result.reviewState.completedAt === undefined
      ? {}
      : { completedAt: result.reviewState.completedAt }),
    files: Object.fromEntries(
      result.reviewState.files.map((file) => [
        file.key,
        {
          key: file.key,
          filePath: file.relativePath,
          ...(file.oldRelativePath ? { oldPath: file.oldRelativePath } : {}),
          scope: file.scope,
          ...(file.lastOpenedAt === undefined ? {} : { lastOpenedAt: file.lastOpenedAt }),
          ...(file.lastSeenDiffIdentity ? { lastSeenDiffIdentity: file.lastSeenDiffIdentity } : {}),
          ...(file.reviewedAt === undefined ? {} : { reviewedAt: file.reviewedAt }),
          ...(file.reviewDiffIdentity ? { reviewDiffIdentity: file.reviewDiffIdentity } : {})
        }
      ])
    )
  }
}

function fileStateToWire(file: MobileDiffReviewFileState) {
  return {
    key: file.key,
    relativePath: file.filePath,
    ...(file.oldPath ? { oldRelativePath: file.oldPath } : {}),
    scope: file.scope,
    ...(file.lastOpenedAt === undefined ? {} : { lastOpenedAt: file.lastOpenedAt }),
    ...(file.lastSeenDiffIdentity ? { lastSeenDiffIdentity: file.lastSeenDiffIdentity } : {}),
    ...(file.reviewedAt === undefined ? {} : { reviewedAt: file.reviewedAt }),
    ...(file.reviewDiffIdentity ? { reviewDiffIdentity: file.reviewDiffIdentity } : {})
  }
}
