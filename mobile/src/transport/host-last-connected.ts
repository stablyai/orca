import type { StoredHostProfile } from './types'

export function recordHostLastConnected(
  hosts: StoredHostProfile[],
  hostId: string,
  connectedAt: number
): StoredHostProfile[] {
  const index = hosts.findIndex((host) => host.id === hostId)
  if (index < 0) {
    return hosts
  }
  const next = hosts.slice()
  next[index] = { ...next[index]!, lastConnected: connectedAt }
  return next
}
