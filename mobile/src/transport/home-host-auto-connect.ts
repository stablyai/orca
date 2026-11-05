import type { ConnectionState, HostProfile } from './types'

export const HOME_AUTO_CONNECT_LIMIT = 3

export function selectHomeAutoConnectHostIds(
  hosts: readonly HostProfile[],
  limit = HOME_AUTO_CONNECT_LIMIT
): string[] {
  return [...hosts]
    .filter((host) => host.deviceToken.length > 0 && host.publicKeyB64.length > 0)
    .sort(
      (left, right) => right.lastConnected - left.lastConnected || left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(0, limit))
    .map((host) => host.id)
}

export function resolveHomeHostConnectionState(
  hostId: string,
  state: ConnectionState | undefined,
  autoConnectHostIds: readonly string[]
): ConnectionState {
  return state ?? (autoConnectHostIds.includes(hostId) ? 'connecting' : 'disconnected')
}
