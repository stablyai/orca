import { COMMIT_MESSAGE_GENERATION_TIMEOUT_MS } from '../../shared/mobile-web/host-operation-timeouts'
import {
  MobileWebSourceControlCancelCommitMessagePayloadSchema,
  MobileWebSourceControlCancelCommitMessageResultSchema,
  MobileWebSourceControlGenerateCommitMessagePayloadSchema,
  MobileWebSourceControlGenerateCommitMessageResultSchema,
  type MobileWebSourceControlCancelCommitMessagePayload,
  type MobileWebSourceControlCancelCommitMessageResult,
  type MobileWebSourceControlGenerateCommitMessagePayload,
  type MobileWebSourceControlGenerateCommitMessageResult
} from '../../shared/mobile-web/source-control-commit-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

/** Generation spawns an agent on the Desktop and outlives the host lane's request deadline, so it
 * keeps its own shell operation with a cancel the page can reach while it runs. */
export class MobileWebCommitMessageRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  generate(
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
        { ...options, timeoutMs: options?.timeoutMs ?? COMMIT_MESSAGE_GENERATION_TIMEOUT_MS }
      )
      .then((result) => {
        if (result.previousHead !== payload.expectedHead) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return requireEchoedWorkspaceId(payload.workspaceId, result)
      })
  }

  cancel(
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
}
