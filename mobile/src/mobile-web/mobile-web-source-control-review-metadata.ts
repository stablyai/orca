import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_REVIEW_COMMENT_LIMIT,
  MOBILE_WEB_REVIEW_FILE_STATE_LIMIT,
  MobileWebSourceControlReviewCommentSchema,
  MobileWebSourceControlReviewFileStateSchema,
  MobileWebSourceControlReviewMetadataResultSchema,
  type MobileWebSourceControlReviewComment,
  type MobileWebSourceControlReviewMetadataResult,
  type MobileWebSourceControlReviewState
} from '../../../src/shared/mobile-web/source-control-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'

export async function readMobileWebSourceControlReviewMetadata(args: {
  client: RpcClient
  hostWorkspaceId: string
  workspaceId: string
}): Promise<MobileWebSourceControlReviewMetadataResult> {
  const response = await args.client.sendRequest('worktree.show', {
    worktree: `id:${args.hostWorkspaceId}`
  })
  if (!response.ok || !isRecord(response.result) || !isRecord(response.result.worktree)) {
    throw new MobileWebBrokerError('host_error')
  }
  return sanitizeMetadata(response.result.worktree, args.workspaceId)
}

export async function updateMobileWebSourceControlReviewMetadata(args: {
  client: RpcClient
  hostWorkspaceId: string
  workspaceId: string
  expectedRevision: string
  comments: MobileWebSourceControlReviewComment[]
  reviewState: MobileWebSourceControlReviewState
  assertCurrent: () => void
}): Promise<MobileWebSourceControlReviewMetadataResult> {
  const current = await readMobileWebSourceControlReviewMetadata(args)
  if (current.revision !== args.expectedRevision) {
    throw new MobileWebBrokerError('conflict')
  }
  args.assertCurrent()
  // worktree.set has no CAS; another writer can still win after this preflight.
  const response = await args.client.sendRequest('worktree.set', {
    worktree: `id:${args.hostWorkspaceId}`,
    diffComments: args.comments.map((comment) => ({
      id: comment.id,
      worktreeId: args.hostWorkspaceId,
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
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return readMobileWebSourceControlReviewMetadata(args)
}

function sanitizeMetadata(
  worktree: Record<string, unknown>,
  workspaceId: string
): MobileWebSourceControlReviewMetadataResult {
  const rawComments = Array.isArray(worktree.diffComments) ? worktree.diffComments : []
  const rawReview = isRecord(worktree.mobileDiffReview) ? worktree.mobileDiffReview : {}
  const rawFiles = isRecord(rawReview.files) ? Object.values(rawReview.files) : []
  if (
    rawComments.length > MOBILE_WEB_REVIEW_COMMENT_LIMIT ||
    rawFiles.length > MOBILE_WEB_REVIEW_FILE_STATE_LIMIT
  ) {
    throw new MobileWebBrokerError('too_large')
  }
  const comments = rawComments.map(sanitizeComment)
  const reviewState: MobileWebSourceControlReviewState = {
    version: 1,
    ...(safeTimestamp(rawReview.updatedAt) === undefined
      ? {}
      : { updatedAt: safeTimestamp(rawReview.updatedAt) }),
    ...(safeTimestamp(rawReview.completedAt) === undefined
      ? {}
      : { completedAt: safeTimestamp(rawReview.completedAt) }),
    files: rawFiles.map(sanitizeFileState)
  }
  const revision = metadataRevision({ comments, reviewState })
  return MobileWebSourceControlReviewMetadataResultSchema.parse({
    workspaceId,
    revision,
    comments,
    reviewState
  })
}

function sanitizeComment(value: unknown): MobileWebSourceControlReviewComment {
  if (!isRecord(value)) {
    throw new MobileWebBrokerError('host_error')
  }
  const parsed = MobileWebSourceControlReviewCommentSchema.safeParse({
    id: value.id,
    relativePath: value.filePath,
    ...(value.oldPath === undefined ? {} : { oldRelativePath: value.oldPath }),
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.selectedText === undefined ? {} : { selectedText: value.selectedText }),
    ...(value.startLine === undefined ? {} : { startLine: value.startLine }),
    lineNumber: value.lineNumber,
    body: value.body,
    createdAt: value.createdAt,
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    ...(value.sentAt === undefined ? {} : { sentAt: value.sentAt }),
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    ...(value.diffIdentity === undefined ? {} : { diffIdentity: value.diffIdentity }),
    side: 'modified'
  })
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data
}

function sanitizeFileState(value: unknown) {
  if (!isRecord(value)) {
    throw new MobileWebBrokerError('host_error')
  }
  const parsed = MobileWebSourceControlReviewFileStateSchema.safeParse({
    key: value.key,
    relativePath: value.filePath,
    ...(value.oldPath === undefined ? {} : { oldRelativePath: value.oldPath }),
    scope: value.scope,
    ...(value.lastOpenedAt === undefined ? {} : { lastOpenedAt: value.lastOpenedAt }),
    ...(value.lastSeenDiffIdentity === undefined
      ? {}
      : { lastSeenDiffIdentity: value.lastSeenDiffIdentity }),
    ...(value.reviewedAt === undefined ? {} : { reviewedAt: value.reviewedAt }),
    ...(value.reviewDiffIdentity === undefined
      ? {}
      : { reviewDiffIdentity: value.reviewDiffIdentity })
  })
  if (!parsed.success) {
    throw new MobileWebBrokerError('host_error')
  }
  return parsed.data
}

function metadataRevision(value: unknown): string {
  return Buffer.from(sha256(new TextEncoder().encode(JSON.stringify(value)))).toString('hex')
}

function safeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
