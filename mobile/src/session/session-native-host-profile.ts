import { loadHosts } from '../transport/host-store'

export type SessionNativeHostProfile = {
  deviceToken: string
  endpoint: string
}

export async function loadSessionNativeHostProfile(
  hostId: string
): Promise<SessionNativeHostProfile | null> {
  const host = (await loadHosts()).find((candidate) => candidate.id === hostId)
  return host ? { deviceToken: host.deviceToken, endpoint: host.endpoint } : null
}
