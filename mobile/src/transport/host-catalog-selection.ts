import type { HostCatalogEntry, HostProfile } from './types'

export function selectConnectableHostProfiles(catalog: readonly HostCatalogEntry[]): HostProfile[] {
  return catalog.flatMap((entry) =>
    entry.credentialStatus === 'ready' && entry.profile ? [entry.profile] : []
  )
}
