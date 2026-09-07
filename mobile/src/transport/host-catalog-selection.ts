import type { HostCatalogEntry, HostProfile } from './types'

export function selectConnectableHostProfiles(catalog: readonly HostCatalogEntry[]): HostProfile[] {
  return catalog.flatMap((entry) =>
    entry.credentialStatus === 'ready' && entry.profile ? [entry.profile] : []
  )
}

export function sortHostsByLastConnected<T extends { lastConnected: number }>(
  hosts: readonly T[]
): T[] {
  return [...hosts].sort((left, right) => right.lastConnected - left.lastConnected)
}
