import type { HostProfile, StoredHostProfile } from './types'

export class MobileRelayUpgradeHostRemovedError extends Error {}

export function toStoredHostProfile(host: HostProfile): StoredHostProfile {
  return {
    id: host.id,
    name: host.name,
    endpoint: host.endpoint,
    publicKeyB64: host.publicKeyB64,
    lastConnected: host.lastConnected
  }
}

export function prepareStoredHostPersistence(
  hosts: StoredHostProfile[],
  stored: StoredHostProfile,
  requireExisting: boolean
): {
  hosts: StoredHostProfile[]
  duplicateHostIds: Set<string>
  updatedExistingHost: boolean
} {
  const duplicateHostIds = new Set(
    hosts
      .filter(
        (candidate) => candidate.id !== stored.id && candidate.publicKeyB64 === stored.publicKeyB64
      )
      .map(({ id }) => id)
  )
  const updatedExistingHost = hosts.some(({ id }) => id === stored.id)
  if (!updatedExistingHost && requireExisting) {
    throw new MobileRelayUpgradeHostRemovedError('mobile relay upgrade host was removed')
  }
  const retained = hosts.filter(({ id }) => !duplicateHostIds.has(id))
  return {
    hosts: updatedExistingHost
      ? retained.map((candidate) => (candidate.id === stored.id ? stored : candidate))
      : [...retained, stored],
    duplicateHostIds,
    updatedExistingHost
  }
}
