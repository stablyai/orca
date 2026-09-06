import type { z } from 'zod'
import {
  MobileWebSourceControlBranchComparePayloadSchema,
  MobileWebSourceControlBranchCompareResultSchema,
  MobileWebSourceControlBranchesPayloadSchema,
  MobileWebSourceControlBranchesResultSchema,
  MobileWebSourceControlCommitComparePayloadSchema,
  MobileWebSourceControlCommitCompareResultSchema,
  MobileWebSourceControlHistoryPayloadSchema,
  MobileWebSourceControlHistoryResultSchema,
  type MobileWebSourceControlBranchComparePayload,
  type MobileWebSourceControlBranchCompareResult,
  type MobileWebSourceControlBranchesPayload,
  type MobileWebSourceControlBranchesResult,
  type MobileWebSourceControlCommitComparePayload,
  type MobileWebSourceControlCommitCompareResult,
  type MobileWebSourceControlHistoryPayload,
  type MobileWebSourceControlHistoryResult
} from '../../shared/mobile-web/source-control-history-contract'
import {
  MobileWebSourceControlCancelCommitMessagePayloadSchema,
  MobileWebSourceControlCancelCommitMessageResultSchema,
  MobileWebSourceControlCommitPayloadSchema,
  MobileWebSourceControlCommitResultSchema,
  MobileWebSourceControlGenerateCommitMessagePayloadSchema,
  MobileWebSourceControlGenerateCommitMessageResultSchema,
  type MobileWebSourceControlCancelCommitMessagePayload,
  type MobileWebSourceControlCancelCommitMessageResult,
  type MobileWebSourceControlCommitPayload,
  type MobileWebSourceControlCommitResult,
  type MobileWebSourceControlGenerateCommitMessagePayload,
  type MobileWebSourceControlGenerateCommitMessageResult
} from '../../shared/mobile-web/source-control-commit-contract'
import {
  MobileWebSourceControlDiscardPayloadSchema,
  MobileWebSourceControlMutationResultSchema,
  MobileWebSourceControlStagePayloadSchema,
  MobileWebSourceControlUnstagePayloadSchema,
  type MobileWebSourceControlDiscardPayload,
  type MobileWebSourceControlMutationOperation,
  type MobileWebSourceControlMutationResult,
  type MobileWebSourceControlStagePayload,
  type MobileWebSourceControlUnstagePayload
} from '../../shared/mobile-web/source-control-mutation-contract'
import {
  MobileWebSourceControlDiffPayloadSchema,
  MobileWebSourceControlDiffResultSchema,
  MobileWebSourceControlStatusPayloadSchema,
  MobileWebSourceControlStatusResultSchema,
  type MobileWebSourceControlDiffPayload,
  type MobileWebSourceControlDiffResult,
  type MobileWebSourceControlStatusPayload,
  type MobileWebSourceControlStatusResult
} from '../../shared/mobile-web/source-control-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSourceControlRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  status(
    payload: MobileWebSourceControlStatusPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlStatusResult> {
    return this.requests
      .request(
        'sourceControl',
        'status',
        payload,
        MobileWebSourceControlStatusPayloadSchema,
        MobileWebSourceControlStatusResultSchema,
        options
      )
      .then((result) => {
        if (result.entries.length > payload.limit) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return requireEchoedWorkspaceId(payload.workspaceId, result)
      })
  }

  diff(
    payload: MobileWebSourceControlDiffPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlDiffResult> {
    return this.requests
      .request(
        'sourceControl',
        'diff',
        payload,
        MobileWebSourceControlDiffPayloadSchema,
        MobileWebSourceControlDiffResultSchema,
        options
      )
      .then((result) => {
        if (
          result.relativePath !== payload.relativePath ||
          result.area !== payload.area ||
          (result.kind === 'text' &&
            (result.offset !== payload.offset ||
              result.rows.length > payload.limit ||
              (payload.expectedRevision !== undefined &&
                result.revision !== payload.expectedRevision)))
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return requireEchoedWorkspaceId(payload.workspaceId, result)
      })
  }

  branches(
    payload: MobileWebSourceControlBranchesPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlBranchesResult> {
    return this.requests
      .request(
        'sourceControl',
        'branches',
        payload,
        MobileWebSourceControlBranchesPayloadSchema,
        MobileWebSourceControlBranchesResultSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  history(
    payload: MobileWebSourceControlHistoryPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlHistoryResult> {
    return this.requests
      .request(
        'sourceControl',
        'history',
        payload,
        MobileWebSourceControlHistoryPayloadSchema,
        MobileWebSourceControlHistoryResultSchema,
        options
      )
      .then((result) => {
        if (result.limit !== payload.limit || result.items.length > payload.limit) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return requireEchoedWorkspaceId(payload.workspaceId, result)
      })
  }

  branchCompare(
    payload: MobileWebSourceControlBranchComparePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlBranchCompareResult> {
    return this.requests
      .request(
        'sourceControl',
        'branchCompare',
        payload,
        MobileWebSourceControlBranchComparePayloadSchema,
        MobileWebSourceControlBranchCompareResultSchema,
        options
      )
      .then((result) => {
        if (
          result.baseRef !== payload.baseRef ||
          result.offset !== payload.offset ||
          result.entries.length > payload.limit ||
          (payload.expectedRevision && result.revision !== payload.expectedRevision)
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return requireEchoedWorkspaceId(payload.workspaceId, result)
      })
  }

  commitCompare(
    payload: MobileWebSourceControlCommitComparePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlCommitCompareResult> {
    return this.requests
      .request(
        'sourceControl',
        'commitCompare',
        payload,
        MobileWebSourceControlCommitComparePayloadSchema,
        MobileWebSourceControlCommitCompareResultSchema,
        options
      )
      .then((result) => {
        if (result.commitId !== payload.commitId) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return requireEchoedWorkspaceId(payload.workspaceId, result)
      })
  }

  stage(
    payload: MobileWebSourceControlStagePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlMutationResult> {
    return this.mutation('stage', payload, MobileWebSourceControlStagePayloadSchema, options)
  }

  unstage(
    payload: MobileWebSourceControlUnstagePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlMutationResult> {
    return this.mutation('unstage', payload, MobileWebSourceControlUnstagePayloadSchema, options)
  }

  discard(
    payload: MobileWebSourceControlDiscardPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlMutationResult> {
    return this.mutation('discard', payload, MobileWebSourceControlDiscardPayloadSchema, options)
  }

  commit(
    payload: MobileWebSourceControlCommitPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlCommitResult> {
    return this.requests
      .request(
        'sourceControl',
        'commit',
        payload,
        MobileWebSourceControlCommitPayloadSchema,
        MobileWebSourceControlCommitResultSchema,
        options
      )
      .then((result) => matchingCommitIdentity(payload, result))
  }

  generateCommitMessage(
    payload: MobileWebSourceControlGenerateCommitMessagePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlGenerateCommitMessageResult> {
    return this.requests
      .request(
        'sourceControl',
        'generateCommitMessage',
        payload,
        MobileWebSourceControlGenerateCommitMessagePayloadSchema,
        MobileWebSourceControlGenerateCommitMessageResultSchema,
        options
      )
      .then((result) => matchingCommitIdentity(payload, result))
  }

  cancelCommitMessageGeneration(
    payload: MobileWebSourceControlCancelCommitMessagePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlCancelCommitMessageResult> {
    return this.requests
      .request(
        'sourceControl',
        'cancelCommitMessageGeneration',
        payload,
        MobileWebSourceControlCancelCommitMessagePayloadSchema,
        MobileWebSourceControlCancelCommitMessageResultSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  private mutation<TPayload extends { workspaceId: string; entries: { relativePath: string }[] }>(
    operation: MobileWebSourceControlMutationOperation,
    payload: TPayload,
    schema: z.ZodType<TPayload>,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlMutationResult> {
    return this.requests
      .request(
        'sourceControl',
        operation,
        payload,
        schema,
        MobileWebSourceControlMutationResultSchema,
        options
      )
      .then((result) => {
        requireEchoedWorkspaceId(payload.workspaceId, result)
        const expectedPaths = payload.entries.map((entry) => entry.relativePath)
        if (
          result.operation !== operation ||
          result.relativePaths.length !== expectedPaths.length ||
          result.relativePaths.some((path, index) => path !== expectedPaths[index])
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }
}

function matchingCommitIdentity<
  TPayload extends { workspaceId: string; expectedHead: string },
  TResult extends { workspaceId: string; previousHead: string }
>(payload: TPayload, result: TResult): TResult {
  if (result.previousHead !== payload.expectedHead) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return requireEchoedWorkspaceId(payload.workspaceId, result)
}
