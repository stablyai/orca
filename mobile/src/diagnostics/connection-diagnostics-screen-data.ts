import type { ConnectionLogStore } from '../transport/connection-log-buffer'
import type { ConnectionLogEntry, HostProfile } from '../transport/types'

export function selectDiagnosticsHostId(
  hosts: readonly HostProfile[],
  requestedHostId: string | undefined,
  previousHostId: string | null
): string | null {
  if (requestedHostId && hosts.some((host) => host.id === requestedHostId)) {
    return requestedHostId
  }
  if (previousHostId && hosts.some((host) => host.id === previousHostId)) {
    return previousHostId
  }
  return hosts[0]?.id ?? null
}

export async function readHydratedConnectionLog(
  store: Pick<ConnectionLogStore, 'hydrate' | 'get'>,
  hostId: string
): Promise<readonly ConnectionLogEntry[]> {
  await store.hydrate(hostId).catch(() => {})
  return store.get(hostId)
}
