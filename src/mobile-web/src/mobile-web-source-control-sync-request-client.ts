import {
  MobileWebSourceControlAbortPayloadSchema,
  MobileWebSourceControlCheckoutPayloadSchema,
  MobileWebSourceControlPullPayloadSchema,
  MobileWebSourceControlPushPayloadSchema,
  MobileWebSourceControlRebasePayloadSchema,
  MobileWebSourceControlRepositoryStatePayloadSchema,
  MobileWebSourceControlRepositoryStateSchema,
  MobileWebSourceControlSyncPayloadSchema,
  type MobileWebSourceControlAbortPayload,
  type MobileWebSourceControlCheckoutPayload,
  type MobileWebSourceControlPullPayload,
  type MobileWebSourceControlPushPayload,
  type MobileWebSourceControlRebasePayload,
  type MobileWebSourceControlRepositoryState,
  type MobileWebSourceControlRepositoryStatePayload,
  type MobileWebSourceControlSyncPayload
} from '../../shared/mobile-web/source-control-sync-contract'
import { withPageWorkspaceId } from './mobile-web-host-workspace-result'
import { MobileWebSourceControlHostClient } from './mobile-web-source-control-host-client'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'

export class MobileWebSourceControlSyncRequestClient extends MobileWebSourceControlHostClient {
  repositoryState(
    payload: MobileWebSourceControlRepositoryStatePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlRepositoryState> {
    return this.host(
      MobileWebSourceControlRepositoryStatePayloadSchema,
      payload,
      'mobileWeb.sourceControl.repositoryState',
      {},
      options
    ).then((result) =>
      MobileWebSourceControlRepositoryStateSchema.parse(
        withPageWorkspaceId(result, payload.workspaceId)
      )
    )
  }

  checkout(
    payload: MobileWebSourceControlCheckoutPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.write(
      MobileWebSourceControlCheckoutPayloadSchema,
      payload,
      'git.checkout',
      { branch: payload.branch },
      options
    )
  }

  fetch(
    payload: MobileWebSourceControlSyncPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.write(MobileWebSourceControlSyncPayloadSchema, payload, 'git.fetch', {}, options)
  }

  pull(
    payload: MobileWebSourceControlPullPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.write(
      MobileWebSourceControlPullPayloadSchema,
      payload,
      payload.strategy === 'fast-forward' ? 'git.fastForward' : 'git.pull',
      {},
      options
    )
  }

  push(
    payload: MobileWebSourceControlPushPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.write(
      MobileWebSourceControlPushPayloadSchema,
      payload,
      'git.push',
      { publish: payload.mode === 'publish' },
      options
    )
  }

  rebase(
    payload: MobileWebSourceControlRebasePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.write(
      MobileWebSourceControlRebasePayloadSchema,
      payload,
      'git.rebaseFromBase',
      { baseRef: payload.baseRef },
      options
    )
  }

  abort(
    payload: MobileWebSourceControlAbortPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.write(
      MobileWebSourceControlAbortPayloadSchema,
      payload,
      payload.conflictOperation === 'merge' ? 'git.abortMerge' : 'git.abortRebase',
      {},
      options
    )
  }

  /** A refused Git write answers with an RPC error, so a resolved call is the only success. */
  private write(
    schema: { safeParse: (value: unknown) => { success: boolean } },
    payload: { workspaceId: string },
    method: string,
    params: Record<string, unknown>,
    options?: MobileWebBridgeRequestOptions
  ): Promise<void> {
    return this.hostWrite(schema, payload, method, params, options).then(() => undefined)
  }
}
