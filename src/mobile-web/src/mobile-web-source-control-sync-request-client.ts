import type { z } from 'zod'
import {
  MobileWebSourceControlAbortPayloadSchema,
  MobileWebSourceControlCheckoutPayloadSchema,
  MobileWebSourceControlFetchPayloadSchema,
  MobileWebSourceControlPullPayloadSchema,
  MobileWebSourceControlPushPayloadSchema,
  MobileWebSourceControlRebasePayloadSchema,
  MobileWebSourceControlRepositoryStateSchema,
  MobileWebSourceControlSyncResultSchema,
  MobileWebSourceControlUpstreamPayloadSchema,
  type MobileWebSourceControlAbortPayload,
  type MobileWebSourceControlCheckoutPayload,
  type MobileWebSourceControlFetchPayload,
  type MobileWebSourceControlPullPayload,
  type MobileWebSourceControlPushPayload,
  type MobileWebSourceControlRebasePayload,
  type MobileWebSourceControlRepositoryState,
  type MobileWebSourceControlSyncOperation,
  type MobileWebSourceControlSyncResult,
  type MobileWebSourceControlUpstreamPayload
} from '../../shared/mobile-web/source-control-sync-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSourceControlSyncRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  upstream(
    payload: MobileWebSourceControlUpstreamPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlRepositoryState> {
    return this.requests
      .request(
        'sourceControl',
        'upstream',
        payload,
        MobileWebSourceControlUpstreamPayloadSchema,
        MobileWebSourceControlRepositoryStateSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  checkout(
    payload: MobileWebSourceControlCheckoutPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlSyncResult> {
    return this.action(
      'branch',
      payload,
      MobileWebSourceControlCheckoutPayloadSchema,
      options
    ).then((result) => {
      if (result.operation !== 'branch' || result.branch !== payload.branch) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return result
    })
  }

  fetch(
    payload: MobileWebSourceControlFetchPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlSyncResult> {
    return this.action('fetch', payload, MobileWebSourceControlFetchPayloadSchema, options)
  }

  pull(
    payload: MobileWebSourceControlPullPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlSyncResult> {
    return this.action('pull', payload, MobileWebSourceControlPullPayloadSchema, options)
  }

  push(
    payload: MobileWebSourceControlPushPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlSyncResult> {
    return this.action('push', payload, MobileWebSourceControlPushPayloadSchema, options)
  }

  rebase(
    payload: MobileWebSourceControlRebasePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlSyncResult> {
    return this.action('rebase', payload, MobileWebSourceControlRebasePayloadSchema, options)
  }

  abort(
    payload: MobileWebSourceControlAbortPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlSyncResult> {
    return this.action('abort', payload, MobileWebSourceControlAbortPayloadSchema, options)
  }

  private action<
    TPayload extends {
      workspaceId: string
      expectedHead: string | null
      expectedBranch: string | null
    }
  >(
    operation: MobileWebSourceControlSyncOperation,
    payload: TPayload,
    schema: z.ZodType<TPayload>,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlSyncResult> {
    return this.requests
      .request(
        'sourceControl',
        operation,
        payload,
        schema,
        MobileWebSourceControlSyncResultSchema,
        options
      )
      .then((result) => {
        if (
          result.operation !== operation ||
          result.previousHead !== payload.expectedHead ||
          result.previousBranch !== payload.expectedBranch
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return requireEchoedWorkspaceId(payload.workspaceId, result)
      })
  }
}
