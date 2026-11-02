import type { WslHostConnectIntent } from '../../shared/wsl-host-types'

/** What a renderer's `wslHosts:connect` asks of the service. */
export function wslHostConnectOptions(request: {
  intent?: unknown
  withdrawPendingRemoval?: unknown
}): { intent?: WslHostConnectIntent; withdrawPendingRemoval: boolean } {
  return {
    // The Settings Connect is the user's own: it keeps a host whose Remove didn't finish. A caller
    // passing false gets the "removal pending" refusal instead.
    withdrawPendingRemoval: request.withdrawPendingRemoval !== false,
    ...(request.intent === 'update' || request.intent === 'force' ? { intent: request.intent } : {})
  }
}
