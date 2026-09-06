import type { HostProfile } from '../transport/types'

const unavailable = () => Promise.reject(new Error('Native host storage unavailable'))

export async function loadHosts(): Promise<HostProfile[]> {
  return []
}

export const resolvePairingHostIdentity: (
  publicKeyB64: string,
  newHostId: string
) => Promise<{ id: string; name: string }> = unavailable

export class MobileRelayUpgradeHostRemovedError extends Error {}

export const saveHost: (host: HostProfile) => Promise<void> = unavailable
export const saveExistingHostRelayUpgrade: (host: HostProfile) => Promise<void> = unavailable
export const removeHost: (hostId: string) => Promise<void> = unavailable

export const retryPendingHostCredentialCleanup: () => Promise<{
  clearedCount: number
  remainingIds: string[]
  storageUnreadable: boolean
}> = unavailable

export const updateHostNameAndEndpoint: (
  hostId: string,
  updates: { name?: string; endpoint?: string }
) => Promise<void> = unavailable

export async function updateLastConnected(_hostId: string): Promise<void> {}

export function resetHostStoreForTests(): void {}
