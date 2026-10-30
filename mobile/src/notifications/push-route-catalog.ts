import { readStoredHostProfilesForMutation } from '../transport/host-metadata-store'
import { getHostListLoadRevision } from '../transport/host-list-load-sharing'
import type { StoredHostProfile } from '../transport/types'
import { deriveHostFingerprint } from './push-host-fingerprint'

export type RouteCatalogCommit =
  | { status: 'committed'; revision: number; profiles: readonly StoredHostProfile[] }
  | { status: 'unavailable' }
type Projection = { keys: Map<string, string | null>; hosts: Set<string> }
let latest: RouteCatalogCommit | { status: 'fresh' } = { status: 'fresh' }
let projection: Projection | undefined
let projected: RouteCatalogCommit | undefined
export function commitRouteCatalog(value: RouteCatalogCommit): void {
  latest = value
  if (value.status === 'unavailable') {
    projected = undefined
    projection = undefined
  }
}
export function routeCatalogIdentity(): Set<string> | undefined {
  if (latest?.status !== 'committed') {
    return undefined
  }
  if (projected !== latest) {
    const keys = new Map<string, string | null>()
    const hosts = new Set<string>()
    for (const profile of latest.profiles) {
      const publicKey = profile.publicKeyB64
      let fingerprint = keys.get(publicKey)
      if (fingerprint === undefined) {
        fingerprint = projection?.keys.has(publicKey)
          ? (projection.keys.get(publicKey) ?? null)
          : deriveHostFingerprint(publicKey)
        keys.set(publicKey, fingerprint)
      }
      if (fingerprint) {
        hosts.add(fingerprint)
      }
    }
    const same =
      projection?.hosts.size === hosts.size &&
      [...hosts].every((host) => projection?.hosts.has(host))
    projection = { keys, hosts: same && projection ? projection.hosts : hosts }
    projected = latest
  }
  return projection?.hosts
}
export async function readRouteCatalog(): Promise<Set<string>> {
  const current = routeCatalogIdentity()
  if (current) {
    return current
  }
  const started = latest
  const revision = getHostListLoadRevision()
  const profiles = await readStoredHostProfilesForMutation()
  if (latest === started) {
    latest = { status: 'committed', revision, profiles }
  }
  const hosts = routeCatalogIdentity()
  if (!hosts) {
    throw new Error('Route catalog unavailable')
  }
  return hosts
}
export function freshRouteCatalog(): void {
  latest = { status: 'fresh' }
  projected = undefined
}
export function clearRouteCatalog(): void {
  freshRouteCatalog()
  projection = undefined
}
