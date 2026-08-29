import type { StoredHostProfile } from './types'

type StoredHostUpdates = { name?: string; endpoint?: string; lastConnected?: number }

export function updateStoredHostProfile(
  hosts: StoredHostProfile[],
  hostId: string,
  updates: StoredHostUpdates
): StoredHostProfile[] {
  const index = hosts.findIndex((host) => host.id === hostId)
  if (index === -1) {
    throw new Error('Host not found')
  }
  const next = hosts.slice()
  next[index] = { ...next[index]!, ...updates }
  return next
}
