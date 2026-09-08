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
  MobileWebSourceControlCommitPayloadSchema,
  MobileWebSourceControlCommitResultSchema,
  type MobileWebSourceControlCommitPayload,
  type MobileWebSourceControlCommitResult
} from '../../shared/mobile-web/source-control-commit-contract'
import {
  MobileWebSourceControlMutationPayloadSchema,
  type MobileWebSourceControlMutationOperation,
  type MobileWebSourceControlMutationPayload
} from '../../shared/mobile-web/source-control-mutation-contract'

import { withPageWorkspaceId } from './mobile-web-host-workspace-result'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import { MobileWebSourceControlReadClient } from './mobile-web-source-control-read-request-client'

const MUTATION_METHODS: Record<MobileWebSourceControlMutationOperation, [string, string]> = {
  stage: ['git.stage', 'git.bulkStage'],
  unstage: ['git.unstage', 'git.bulkUnstage'],
  discard: ['git.discard', 'git.bulkDiscard']
}

export class MobileWebSourceControlRequestClient extends MobileWebSourceControlReadClient {
  branches(
    payload: MobileWebSourceControlBranchesPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlBranchesResult> {
    return this.host(
      MobileWebSourceControlBranchesPayloadSchema,
      payload,
      'mobileWeb.sourceControl.branches',
      {},
      options
    ).then((result) =>
      MobileWebSourceControlBranchesResultSchema.parse(
        withPageWorkspaceId(result, payload.workspaceId)
      )
    )
  }

  history(
    payload: MobileWebSourceControlHistoryPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlHistoryResult> {
    return this.host(
      MobileWebSourceControlHistoryPayloadSchema,
      payload,
      'mobileWeb.sourceControl.history',
      { limit: payload.limit, ...(payload.baseRef ? { baseRef: payload.baseRef } : {}) },
      options
    ).then((result) => {
      const parsed = MobileWebSourceControlHistoryResultSchema.parse(
        withPageWorkspaceId(result, payload.workspaceId)
      )
      if (parsed.limit !== payload.limit || parsed.items.length > payload.limit) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed
    })
  }

  branchCompare(
    payload: MobileWebSourceControlBranchComparePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlBranchCompareResult> {
    return this.host(
      MobileWebSourceControlBranchComparePayloadSchema,
      payload,
      'mobileWeb.sourceControl.branchCompare',
      { baseRef: payload.baseRef },
      options
    ).then((result) => {
      const parsed = MobileWebSourceControlBranchCompareResultSchema.parse(
        withPageWorkspaceId(result, payload.workspaceId)
      )
      if (parsed.baseRef !== payload.baseRef) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed
    })
  }

  commitCompare(
    payload: MobileWebSourceControlCommitComparePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlCommitCompareResult> {
    return this.host(
      MobileWebSourceControlCommitComparePayloadSchema,
      payload,
      'mobileWeb.sourceControl.commitCompare',
      { commitId: payload.commitId },
      options
    ).then((result) => {
      const parsed = MobileWebSourceControlCommitCompareResultSchema.parse(
        withPageWorkspaceId(result, payload.workspaceId)
      )
      if (parsed.commitId !== payload.commitId) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed
    })
  }

  stage(
    payload: MobileWebSourceControlMutationPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.mutate('stage', payload, options)
  }

  unstage(
    payload: MobileWebSourceControlMutationPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.mutate('unstage', payload, options)
  }

  discard(
    payload: MobileWebSourceControlMutationPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.mutate('discard', payload, options)
  }

  commit(
    payload: MobileWebSourceControlCommitPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlCommitResult> {
    return this.hostWrite(
      MobileWebSourceControlCommitPayloadSchema,
      payload,
      'git.commit',
      { message: payload.message.trim() },
      options
    ).then((result) => MobileWebSourceControlCommitResultSchema.parse(result))
  }

  private mutate(
    operation: MobileWebSourceControlMutationOperation,
    payload: MobileWebSourceControlMutationPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    const [single, bulk] = MUTATION_METHODS[operation]
    const paths = payload.relativePaths
    return this.hostWrite(
      MobileWebSourceControlMutationPayloadSchema,
      payload,
      paths.length > 1 ? bulk : single,
      paths.length > 1 ? { filePaths: paths } : { filePath: paths[0] },
      options
    ).then(() => undefined)
  }
}
