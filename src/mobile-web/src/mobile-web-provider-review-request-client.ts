import {
  MobileWebProviderReviewMutationPayloadSchema,
  MobileWebProviderReviewMutationResultSchema,
  MobileWebProviderReviewPayloadSchema,
  MobileWebProviderReviewResultSchema,
  type MobileWebProviderReviewMutationPayload,
  type MobileWebProviderReviewMutationResult,
  type MobileWebProviderReviewPayload,
  type MobileWebProviderReviewResult
} from '../../shared/mobile-web/provider-review-contract'
import {
  MobileWebProviderReviewManagementPayloadSchema,
  MobileWebProviderReviewManagementResultSchema,
  type MobileWebProviderReviewManagementPayload,
  type MobileWebProviderReviewManagementResult
} from '../../shared/mobile-web/provider-review-management-contract'
import {
  MobileWebProviderReviewQueryPayloadSchema,
  MobileWebProviderReviewQueryResultSchema,
  type MobileWebProviderReviewQueryPayload,
  type MobileWebProviderReviewQueryResult
} from '../../shared/mobile-web/provider-review-query-contract'
import {
  MobileWebProviderReviewDiffPayloadSchema,
  MobileWebProviderReviewDiffResultSchema,
  type MobileWebProviderReviewDiffPayload,
  type MobileWebProviderReviewDiffResult
} from '../../shared/mobile-web/provider-review-diff-contract'
import {
  MobileWebProviderReviewSubmissionPayloadSchema,
  MobileWebProviderReviewSubmissionResultSchema,
  type MobileWebProviderReviewSubmissionPayload,
  type MobileWebProviderReviewSubmissionResult
} from '../../shared/mobile-web/provider-review-submission-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebProviderReviewRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  review(
    payload: MobileWebProviderReviewPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewResult> {
    return this.requests
      .request(
        'provider',
        'review',
        payload,
        MobileWebProviderReviewPayloadSchema,
        MobileWebProviderReviewResultSchema,
        options
      )
      .then((result) => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.observedHead !== payload.expectedHead ||
          result.branch !== payload.expectedBranch
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  reviewDiff(
    payload: MobileWebProviderReviewDiffPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewDiffResult> {
    return this.requests
      .request(
        'provider',
        'reviewDiff',
        payload,
        MobileWebProviderReviewDiffPayloadSchema,
        MobileWebProviderReviewDiffResultSchema,
        options
      )
      .then((result) => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.observedHead !== payload.expectedHead ||
          result.branch !== payload.expectedBranch ||
          result.provider !== payload.provider ||
          result.reviewNumber !== payload.reviewNumber ||
          result.reviewHead !== payload.expectedReviewHead ||
          result.path !== payload.path ||
          (result.kind === 'text' && result.rows.length > payload.limit) ||
          !diffPageMatchesPayload(result, payload)
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  mutateReview(
    payload: MobileWebProviderReviewMutationPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewMutationResult> {
    return this.requests
      .request(
        'provider',
        'mutateReview',
        payload,
        MobileWebProviderReviewMutationPayloadSchema,
        MobileWebProviderReviewMutationResultSchema,
        options
      )
      .then((result) => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.provider !== payload.provider ||
          result.reviewNumber !== payload.reviewNumber ||
          !mutationResultMatchesPayload(result, payload)
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  manageReview(
    payload: MobileWebProviderReviewManagementPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewManagementResult> {
    return this.requests
      .request(
        'provider',
        'manageReview',
        payload,
        MobileWebProviderReviewManagementPayloadSchema,
        MobileWebProviderReviewManagementResultSchema,
        options
      )
      .then((result) => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.provider !== payload.provider ||
          result.reviewNumber !== payload.reviewNumber ||
          result.action !== payload.action
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  reviewQuery(
    payload: MobileWebProviderReviewQueryPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewQueryResult> {
    return this.requests
      .request(
        'provider',
        'reviewQuery',
        payload,
        MobileWebProviderReviewQueryPayloadSchema,
        MobileWebProviderReviewQueryResultSchema,
        options
      )
      .then((result) => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.provider !== payload.provider ||
          result.reviewNumber !== payload.reviewNumber ||
          result.query !== payload.query
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  submitReview(
    payload: MobileWebProviderReviewSubmissionPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebProviderReviewSubmissionResult> {
    return this.requests
      .request(
        'provider',
        'submitReview',
        payload,
        MobileWebProviderReviewSubmissionPayloadSchema,
        MobileWebProviderReviewSubmissionResultSchema,
        options
      )
      .then((result) => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.provider !== payload.provider ||
          result.reviewNumber !== payload.reviewNumber ||
          result.expectedReviewHead !== payload.expectedReviewHead ||
          result.submissionId !== payload.submissionId ||
          result.action !== payload.action ||
          !sameStringArray(
            result.submittedCommentIds,
            payload.comments.map((comment) => comment.id)
          )
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function diffPageMatchesPayload(
  result: MobileWebProviderReviewDiffResult,
  payload: MobileWebProviderReviewDiffPayload
): boolean {
  if (
    payload.expectedRevision &&
    (result.kind !== 'text' || result.revision !== payload.expectedRevision)
  ) {
    return false
  }
  if (payload.focusLine !== undefined) {
    return result.kind === 'text' && result.focusLine === payload.focusLine
  }
  return result.kind !== 'text' || result.offset === payload.offset
}

function mutationResultMatchesPayload(
  result: MobileWebProviderReviewMutationResult,
  payload: MobileWebProviderReviewMutationPayload
): boolean {
  if (result.action !== payload.action) {
    return false
  }
  if (result.action === 'comment' && payload.action === 'comment') {
    return true
  }
  if (result.action === 'reply' && payload.action === 'reply') {
    return result.commentId === payload.commentId && result.threadId === payload.threadId
  }
  if (result.action === 'inlineComment' && payload.action === 'inlineComment') {
    return (
      result.expectedReviewHead === payload.expectedReviewHead &&
      result.path === payload.path &&
      result.line === payload.line &&
      result.startLine === payload.startLine
    )
  }
  return (
    result.action === 'setThreadResolved' &&
    payload.action === 'setThreadResolved' &&
    result.threadId === payload.threadId &&
    result.resolved === payload.resolved
  )
}
