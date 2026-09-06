import type { ZodType } from 'zod'
import type { MobileWebBridgeOperationName } from '../../shared/mobile-web/bridge-operation-registry'
import {
  MobileWebTaskItemChecksPayloadSchema,
  MobileWebTaskItemChecksResultSchema,
  MobileWebTaskItemFileContentsPayloadSchema,
  MobileWebTaskItemFileContentsResultSchema,
  MobileWebTaskItemFileMutationResultSchema,
  MobileWebTaskItemFileViewedPayloadSchema,
  MobileWebTaskItemInlineCommentPayloadSchema,
  MobileWebTaskItemInlineCommentResultSchema,
  MobileWebTaskItemRerunChecksPayloadSchema,
  type MobileWebTaskItemChecksPayload,
  type MobileWebTaskItemFileContentsPayload,
  type MobileWebTaskItemFileViewedPayload,
  type MobileWebTaskItemInlineCommentPayload,
  type MobileWebTaskItemRerunChecksPayload
} from '../../shared/mobile-web/task-item-file-contract'
import {
  MobileWebTaskItemMetadataPayloadSchema,
  MobileWebTaskItemMutationResultSchema,
  MobileWebTaskItemStatusPayloadSchema,
  type MobileWebTaskItemMetadataPayload,
  type MobileWebTaskItemStatusPayload
} from '../../shared/mobile-web/task-item-mutation-contract'
import {
  MobileWebTaskItemCommentPayloadSchema,
  MobileWebTaskItemCommentResultSchema,
  MobileWebTaskItemMergePayloadSchema,
  MobileWebTaskItemReviewersPayloadSchema,
  MobileWebTaskItemReviewMutationResultSchema,
  MobileWebTaskItemReviewReplyPayloadSchema,
  MobileWebTaskItemReviewThreadPayloadSchema,
  type MobileWebTaskItemCommentPayload,
  type MobileWebTaskItemMergePayload,
  type MobileWebTaskItemReviewersPayload,
  type MobileWebTaskItemReviewReplyPayload,
  type MobileWebTaskItemReviewThreadPayload
} from '../../shared/mobile-web/task-item-review-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebTaskProjectRequestClient } from './mobile-web-task-project-request-client'

export class MobileWebTaskItemRequestClient extends MobileWebTaskProjectRequestClient {
  constructor(requests: MobileWebOneShotRequestClient) {
    super(requests)
  }

  updateHostedTaskStatus(payload: MobileWebTaskItemStatusPayload) {
    return this.requests.request(
      'task',
      'updateHostedTaskStatus',
      payload,
      MobileWebTaskItemStatusPayloadSchema,
      MobileWebTaskItemMutationResultSchema
    )
  }

  updateHostedTaskMetadata(payload: MobileWebTaskItemMetadataPayload) {
    return this.requests.request(
      'task',
      'updateHostedTaskMetadata',
      payload,
      MobileWebTaskItemMetadataPayloadSchema,
      MobileWebTaskItemMutationResultSchema
    )
  }

  addHostedTaskComment(payload: MobileWebTaskItemCommentPayload) {
    return this.requests.request(
      'task',
      'addHostedTaskComment',
      payload,
      MobileWebTaskItemCommentPayloadSchema,
      MobileWebTaskItemCommentResultSchema
    )
  }

  requestHostedTaskReviewers(payload: MobileWebTaskItemReviewersPayload) {
    return this.mutateReview(
      'requestHostedTaskReviewers',
      payload,
      MobileWebTaskItemReviewersPayloadSchema
    )
  }

  resolveHostedTaskReviewThread(payload: MobileWebTaskItemReviewThreadPayload) {
    return this.mutateReview(
      'resolveHostedTaskReviewThread',
      payload,
      MobileWebTaskItemReviewThreadPayloadSchema
    )
  }

  replyHostedTaskReviewComment(payload: MobileWebTaskItemReviewReplyPayload) {
    return this.mutateReview(
      'replyHostedTaskReviewComment',
      payload,
      MobileWebTaskItemReviewReplyPayloadSchema
    )
  }

  mergeHostedTaskReview(payload: MobileWebTaskItemMergePayload) {
    return this.mutateReview('mergeHostedTaskReview', payload, MobileWebTaskItemMergePayloadSchema)
  }

  refreshHostedTaskChecks(payload: MobileWebTaskItemChecksPayload) {
    return this.requests.request(
      'task',
      'refreshHostedTaskChecks',
      payload,
      MobileWebTaskItemChecksPayloadSchema,
      MobileWebTaskItemChecksResultSchema
    )
  }

  rerunHostedTaskChecks(payload: MobileWebTaskItemRerunChecksPayload) {
    return this.mutateFile(
      'rerunHostedTaskChecks',
      payload,
      MobileWebTaskItemRerunChecksPayloadSchema
    )
  }

  setHostedTaskFileViewed(payload: MobileWebTaskItemFileViewedPayload) {
    return this.mutateFile(
      'setHostedTaskFileViewed',
      payload,
      MobileWebTaskItemFileViewedPayloadSchema
    )
  }

  loadHostedTaskFileContents(payload: MobileWebTaskItemFileContentsPayload) {
    return this.requests.request(
      'task',
      'loadHostedTaskFileContents',
      payload,
      MobileWebTaskItemFileContentsPayloadSchema,
      MobileWebTaskItemFileContentsResultSchema
    )
  }

  addHostedTaskInlineComment(payload: MobileWebTaskItemInlineCommentPayload) {
    return this.requests.request(
      'task',
      'addHostedTaskInlineComment',
      payload,
      MobileWebTaskItemInlineCommentPayloadSchema,
      MobileWebTaskItemInlineCommentResultSchema
    )
  }

  private mutateReview(
    operation: MobileWebBridgeOperationName<'task'>,
    payload: unknown,
    schema: ZodType
  ) {
    return this.requests.request(
      'task',
      operation,
      payload,
      schema,
      MobileWebTaskItemReviewMutationResultSchema
    )
  }

  private mutateFile(
    operation: MobileWebBridgeOperationName<'task'>,
    payload: unknown,
    schema: ZodType
  ) {
    return this.requests.request(
      'task',
      operation,
      payload,
      schema,
      MobileWebTaskItemFileMutationResultSchema
    )
  }
}
