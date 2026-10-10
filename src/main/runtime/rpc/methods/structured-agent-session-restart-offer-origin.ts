// Each listed offer says whose it is, for the device asking. The host holds both facts — the
// workspace's creator record and the caller's paired device — so no client judges it from a
// workspace list it may not have loaded yet.

import { restartOfferOrigin } from '../../../../shared/restart-offer-origin'
import type { RpcContext } from '../core'
import { resolveRpcWorkspaceCreatorProvenance } from '../workspace-creator-context'

/** The asking device as workspace creator records name it: null is the host's own user (its desktop
 *  window, or an in-process caller), undefined an authenticated remote caller without a device
 *  identity (its rows go out without an origin). */
function viewerDeviceId(ctx: RpcContext): string | null | undefined {
  if (ctx.pairedDeviceId) {
    return ctx.pairedDeviceId
  }
  if (ctx.caller?.kind === 'desktop') {
    return null
  }
  try {
    return resolveRpcWorkspaceCreatorProvenance(ctx).kind === 'host' ? null : undefined
  } catch {
    return undefined
  }
}

export function withRestartOfferOrigins<Row extends { workspaceId: string }>(
  ctx: RpcContext,
  rows: readonly Row[]
): Row[] {
  const viewer = viewerDeviceId(ctx)
  if (viewer === undefined) {
    return [...rows]
  }
  return rows.map((row) => ({
    ...row,
    origin: restartOfferOrigin(ctx.runtime.restartOfferWorkspaceProvenance(row.workspaceId), viewer)
  }))
}

/** A listing payload with every row's origin added; fields it does not carry stay absent. */
export function withRestartOfferPayloadOrigins<
  Payload extends {
    sessions?: readonly { workspaceId: string }[]
    failed?: readonly { workspaceId: string }[]
  }
>(ctx: RpcContext, payload: Payload): Payload {
  return {
    ...payload,
    ...(payload.sessions ? { sessions: withRestartOfferOrigins(ctx, payload.sessions) } : {}),
    ...(payload.failed ? { failed: withRestartOfferOrigins(ctx, payload.failed) } : {})
  }
}
