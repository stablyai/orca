import {
  MobileWebSourceControlReviewDiffPayloadSchema,
  MobileWebSourceControlReviewDiffResultSchema,
  MobileWebSourceControlReviewLinkPayloadSchema,
  MobileWebSourceControlReviewLinkResultSchema,
  MobileWebSourceControlReviewLinkUpdatePayloadSchema,
  MobileWebSourceControlReviewMetadataPayloadSchema,
  MobileWebSourceControlReviewMetadataResultSchema,
  MobileWebSourceControlReviewMetadataUpdatePayloadSchema,
  MobileWebSourceControlReviewOpenPayloadSchema,
  MobileWebSourceControlReviewTerminalSendPayloadSchema,
  MobileWebSourceControlReviewTerminalSendResultSchema,
  type MobileWebSourceControlReviewDiffPayload,
  type MobileWebSourceControlReviewDiffResult,
  type MobileWebSourceControlReviewLinkPayload,
  type MobileWebSourceControlReviewLinkResult,
  type MobileWebSourceControlReviewLinkUpdatePayload,
  type MobileWebSourceControlReviewMetadataPayload,
  type MobileWebSourceControlReviewMetadataResult,
  type MobileWebSourceControlReviewMetadataUpdatePayload,
  type MobileWebSourceControlReviewOpenPayload,
  type MobileWebSourceControlReviewTerminalSendPayload,
  type MobileWebSourceControlReviewTerminalSendResult
} from '../../shared/mobile-web/source-control-review-contract'
import { rethrowMobileWebReviewError } from './mobile-web-provider-review-conflict'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { withPageWorkspaceId } from './mobile-web-host-workspace-result'
import { MobileWebSourceControlHostClient } from './mobile-web-source-control-host-client'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'

export class MobileWebSourceControlReviewRequestClient extends MobileWebSourceControlHostClient {
  metadata(
    payload: MobileWebSourceControlReviewMetadataPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewMetadataResult> {
    return this.host(
      MobileWebSourceControlReviewMetadataPayloadSchema,
      payload,
      'mobileWeb.sourceControl.reviewMetadata',
      {},
      options
    ).then((result) => this.parseMetadata(result, payload.workspaceId))
  }

  metadataUpdate(
    payload: MobileWebSourceControlReviewMetadataUpdatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewMetadataResult> {
    return this.host(
      MobileWebSourceControlReviewMetadataUpdatePayloadSchema,
      payload,
      'mobileWeb.sourceControl.reviewMetadataUpdate',
      {
        expectedRevision: payload.expectedRevision,
        comments: payload.comments,
        reviewState: payload.reviewState
      },
      options
    )
      .then((result) => this.parseMetadata(result, payload.workspaceId))
      .catch(rethrowMobileWebReviewError)
  }

  link(
    payload: MobileWebSourceControlReviewLinkPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewLinkResult> {
    return this.host(
      MobileWebSourceControlReviewLinkPayloadSchema,
      payload,
      'mobileWeb.sourceControl.reviewLink',
      {},
      options
    ).then((result) => this.parseLink(result, payload.workspaceId))
  }

  linkUpdate(
    payload: MobileWebSourceControlReviewLinkUpdatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewLinkResult> {
    return this.host(
      MobileWebSourceControlReviewLinkUpdatePayloadSchema,
      payload,
      'mobileWeb.sourceControl.reviewLinkUpdate',
      {
        provider: payload.provider,
        number: payload.number,
        ...(payload.baseRef ? { baseRef: payload.baseRef } : {})
      },
      options
    ).then((result) => this.parseLink(result, payload.workspaceId))
  }

  diff(
    payload: MobileWebSourceControlReviewDiffPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewDiffResult> {
    return this.host(
      MobileWebSourceControlReviewDiffPayloadSchema,
      payload,
      'mobileWeb.sourceControl.reviewDiff',
      {
        relativePath: payload.relativePath,
        ...(payload.oldRelativePath ? { oldRelativePath: payload.oldRelativePath } : {}),
        scope: payload.scope,
        ...(payload.compare ? { compare: payload.compare } : {}),
        offset: payload.offset,
        limit: payload.limit,
        ...(payload.expectedRevision ? { expectedRevision: payload.expectedRevision } : {})
      },
      options
    ).then((result) => {
      const parsed = MobileWebSourceControlReviewDiffResultSchema.parse(
        withPageWorkspaceId(result, payload.workspaceId)
      )
      if (parsed.relativePath !== payload.relativePath || parsed.scope !== payload.scope) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed
    })
  }

  open(
    payload: MobileWebSourceControlReviewOpenPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.host(
      MobileWebSourceControlReviewOpenPayloadSchema,
      payload,
      'files.openDiff',
      { relativePath: payload.relativePath, staged: payload.scope === 'staged' },
      options
    ).then(() => null)
  }

  terminalSend(
    payload: MobileWebSourceControlReviewTerminalSendPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlReviewTerminalSendResult> {
    return this.host(
      MobileWebSourceControlReviewTerminalSendPayloadSchema,
      payload,
      'mobileWeb.sourceControl.reviewTerminalSend',
      { tabId: payload.tabId, text: payload.text },
      options
    ).then((result) => MobileWebSourceControlReviewTerminalSendResultSchema.parse(result))
  }

  private parseMetadata(
    result: unknown,
    workspaceId: string
  ): MobileWebSourceControlReviewMetadataResult {
    return MobileWebSourceControlReviewMetadataResultSchema.parse(
      withPageWorkspaceId(result, workspaceId)
    )
  }

  private parseLink(result: unknown, workspaceId: string): MobileWebSourceControlReviewLinkResult {
    return MobileWebSourceControlReviewLinkResultSchema.parse(
      withPageWorkspaceId(result, workspaceId)
    )
  }
}
