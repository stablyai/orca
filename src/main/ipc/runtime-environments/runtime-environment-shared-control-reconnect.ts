import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'

type ReconnectableSharedControl = {
  getDiagnostics(): Pick<RemoteRuntimeSharedConnectionDiagnostics, 'state'> | null
  reconnectNow(): void
}

/**
 * Reconnect unless a socket is already dialing or up: reconnecting closes and reopens a socket that
 * is not ready yet, so it would throw away a connection a moment from ready (e.g. one pre-opened
 * for a wake) and start over.
 */
export function reconnectSharedControlIfIdle(
  connection: ReconnectableSharedControl | undefined
): void {
  const state = connection?.getDiagnostics()?.state
  if (state === 'awaiting_ready' || state === 'awaiting_authenticated' || state === 'ready') {
    return
  }
  connection?.reconnectNow()
}
