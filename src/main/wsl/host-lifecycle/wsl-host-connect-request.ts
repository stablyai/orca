import type {
  WslHostConnectIntent,
  WslHostPastUncountedTerminals
} from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

export type WslHostConnectRequest = {
  intent?: WslHostConnectIntent
  /** Update anyway over an uncounted census, pinned to the build the user confirmed. */
  pastUncountedTerminals?: WslHostPastUncountedTerminals
  withdrawPendingRemoval?: boolean
}

/** What a renderer's `wslHosts:connect` asks of the service. */
export function wslHostConnectOptions(request: {
  intent?: unknown
  pastUncountedTerminals?: unknown
  withdrawPendingRemoval?: unknown
}): WslHostConnectRequest & { withdrawPendingRemoval: boolean } {
  const pastUncounted = readPastUncountedTerminals(request.pastUncountedTerminals)
  return {
    // The Settings Connect is the user's own: it keeps a host whose Remove didn't finish. A caller
    // passing false gets the "removal pending" refusal instead.
    withdrawPendingRemoval: request.withdrawPendingRemoval !== false,
    // Update anyway rides on Update's admission; only the pinned build may be forced past.
    ...(pastUncounted
      ? { intent: 'update' as const, pastUncountedTerminals: pastUncounted }
      : request.intent === 'update' || request.intent === 'force'
        ? { intent: request.intent }
        : {})
  }
}

function readPastUncountedTerminals(value: unknown): WslHostPastUncountedTerminals | null {
  if (typeof value !== 'object' || value === null || !('incumbentVersion' in value)) {
    return null
  }
  const { incumbentVersion } = value
  return typeof incumbentVersion === 'string' || incumbentVersion === null
    ? { incumbentVersion }
    : null
}
