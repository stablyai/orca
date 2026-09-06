import {
  MobileWebSourceControlReviewDiffPayloadSchema,
  MobileWebSourceControlReviewDiffResultSchema,
  MobileWebSourceControlReviewMetadataPayloadSchema,
  MobileWebSourceControlReviewMetadataResultSchema,
  MobileWebSourceControlReviewMetadataUpdatePayloadSchema,
  MobileWebSourceControlReviewLinkPayloadSchema,
  MobileWebSourceControlReviewLinkResultSchema,
  MobileWebSourceControlReviewLinkUpdatePayloadSchema,
  MobileWebSourceControlReviewOpenPayloadSchema,
  MobileWebSourceControlReviewOpenResultSchema,
  MobileWebSourceControlReviewTerminalSendPayloadSchema,
  MobileWebSourceControlReviewTerminalSendResultSchema,
  type MobileWebSourceControlReviewDiffPayload,
  type MobileWebSourceControlReviewDiffResult,
  type MobileWebSourceControlReviewMetadataPayload,
  type MobileWebSourceControlReviewMetadataResult,
  type MobileWebSourceControlReviewMetadataUpdatePayload,
  type MobileWebSourceControlReviewLinkPayload,
  type MobileWebSourceControlReviewLinkResult,
  type MobileWebSourceControlReviewLinkUpdatePayload,
  type MobileWebSourceControlReviewOpenPayload,
  type MobileWebSourceControlReviewTerminalSendPayload,
  type MobileWebSourceControlReviewTerminalSendResult
} from '../../shared/mobile-web/source-control-review-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSourceControlReviewRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  metadata(
    payload: MobileWebSourceControlReviewMetadataPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewMetadataResult> {
    return this.requests
      .request(
        'sourceControl',
        'reviewMetadata',
        payload,
        MobileWebSourceControlReviewMetadataPayloadSchema,
        MobileWebSourceControlReviewMetadataResultSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  metadataUpdate(
    payload: MobileWebSourceControlReviewMetadataUpdatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewMetadataResult> {
    return this.requests
      .request(
        'sourceControl',
        'reviewMetadataUpdate',
        payload,
        MobileWebSourceControlReviewMetadataUpdatePayloadSchema,
        MobileWebSourceControlReviewMetadataResultSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  link(
    payload: MobileWebSourceControlReviewLinkPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewLinkResult> {
    return this.requests
      .request(
        'sourceControl',
        'reviewLink',
        payload,
        MobileWebSourceControlReviewLinkPayloadSchema,
        MobileWebSourceControlReviewLinkResultSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  linkUpdate(
    payload: MobileWebSourceControlReviewLinkUpdatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewLinkResult> {
    return this.requests
      .request(
        'sourceControl',
        'reviewLinkUpdate',
        payload,
        MobileWebSourceControlReviewLinkUpdatePayloadSchema,
        MobileWebSourceControlReviewLinkResultSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  diff(
    payload: MobileWebSourceControlReviewDiffPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewDiffResult> {
    return this.requests
      .request(
        'sourceControl',
        'reviewDiff',
        payload,
        MobileWebSourceControlReviewDiffPayloadSchema,
        MobileWebSourceControlReviewDiffResultSchema,
        options
      )
      .then((result) => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.relativePath !== payload.relativePath ||
          result.scope !== payload.scope
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  open(
    payload: MobileWebSourceControlReviewOpenPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.requests.request(
      'sourceControl',
      'reviewOpen',
      payload,
      MobileWebSourceControlReviewOpenPayloadSchema,
      MobileWebSourceControlReviewOpenResultSchema,
      options
    )
  }

  terminalSend(
    payload: MobileWebSourceControlReviewTerminalSendPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewTerminalSendResult> {
    return this.requests.request(
      'sourceControl',
      'reviewTerminalSend',
      payload,
      MobileWebSourceControlReviewTerminalSendPayloadSchema,
      MobileWebSourceControlReviewTerminalSendResultSchema,
      options
    )
  }
}
