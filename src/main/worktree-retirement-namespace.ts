import { getRepoExecutionHostId, parseExecutionHostId } from '../shared/execution-host'
import {
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../shared/worktree/retired-name-registry'
import type { Repo } from '../shared/repo-types'
import { worktreePathComparisonKey } from './worktree-path-comparison-key'
import { sshEndpointKey, type SshIdentityFields } from './ssh/targets/ssh-target-identity'

/** Repo-id storage survives settings changes; this path-derived copy survives project remove/re-add. */

type RepoHostFields = Pick<Repo, 'connectionId' | 'executionHostId'>

export type SshTargetLookup = (targetId: string) => SshIdentityFields | undefined

/** Unknown SSH endpoints share a path-scoped bucket: over-retire rather than reissue a used path. */
export const UNKNOWN_SSH_HOST_IDENTITY = 'ssh:?'

/** Endpoint/account identity survives target-row replacement while still naming the same filesystem. */
export function retirementHostIdentity(repo: RepoHostFields, lookup?: SshTargetLookup): string {
  const hostId = getRepoExecutionHostId(repo)
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'ssh') {
    return hostId
  }
  const target = lookup?.(parsed.targetId)
  return target ? sshHostIdentity(target) : UNKNOWN_SSH_HOST_IDENTITY
}

export function sshHostIdentity(target: SshIdentityFields): string {
  return `ssh:${sshEndpointKey(target)}`
}

export function retirementNamespaceKey(hostIdentity: string, probePath: string): string {
  return `${hostIdentity}:${worktreePathComparisonKey(probePath)}`
}

export function swapRetirementNamespaceHost(
  namespaceKey: string,
  fromIdentity: string,
  toIdentity: string
): string | null {
  const prefix = `${fromIdentity}:`
  return fromIdentity !== toIdentity && namespaceKey.startsWith(prefix)
    ? `${toIdentity}:${namespaceKey.slice(prefix.length)}`
    : null
}

/** Read canonical and legacy target-ID keys so upgrades retain existing tombstones; write only canonical keys. */
export function retirementNamespaceKeysToRead(
  repo: RepoHostFields,
  namespaceKey: string,
  lookup?: SshTargetLookup
): string[] {
  const legacyKey = swapRetirementNamespaceHost(
    namespaceKey,
    retirementHostIdentity(repo, lookup),
    getRepoExecutionHostId(repo)
  )
  return legacyKey ? [namespaceKey, legacyKey] : [namespaceKey]
}

/** Outlive removed repos so re-add restores tombstones; bound growth by capacity instead. */
export const MAX_RETIREMENT_NAMESPACES = 256

export function recordRetirementNamespaceRegistry(
  namespaces: Record<string, RetiredNameRegistry>,
  namespaceKey: string,
  registry: RetiredNameRegistry
): void {
  // Reinsert to persist LRU order through the object's non-numeric keys and JSON.
  delete namespaces[namespaceKey]
  namespaces[namespaceKey] = registry
  trimRetirementNamespaces(namespaces)
}

/** Every growing writer must trim after reinserting touched keys to refresh their LRU order. */
function trimRetirementNamespaces(namespaces: Record<string, RetiredNameRegistry>): void {
  const keys = Object.keys(namespaces)
  // Clamp to zero: a negative slice end would evict entries from an under-full map.
  const overflow = Math.max(0, keys.length - MAX_RETIREMENT_NAMESPACES)
  for (const stale of keys.slice(0, overflow)) {
    delete namespaces[stale]
  }
}

export type RetirementNamespaceHostMigration = {
  /** Target-ID identities have one owner, so their namespaces can move. */
  moveFrom?: readonly string[]
  /** Endpoint identities can be shared by live targets; copy their tombstones without removing the source. */
  copyFrom?: readonly string[]
  to: string
}

export function migrateRetirementNamespaceHostIdentity(
  namespaces: Record<string, RetiredNameRegistry> | undefined,
  migration: RetirementNamespaceHostMigration
): boolean {
  if (!namespaces) {
    return false
  }
  const visited = new Set<string>()
  let changed = false
  for (const group of [
    { identities: migration.moveFrom ?? [], retainSource: false },
    { identities: migration.copyFrom ?? [], retainSource: true }
  ]) {
    for (const oldIdentity of group.identities) {
      if (!oldIdentity || oldIdentity === migration.to || visited.has(oldIdentity)) {
        continue
      }
      visited.add(oldIdentity)
      if (rekeyRetirementNamespaceHost(namespaces, oldIdentity, migration.to, group.retainSource)) {
        changed = true
      }
    }
  }
  if (changed) {
    trimRetirementNamespaces(namespaces)
  }
  return changed
}

function retiredNameRegistriesEqual(a: RetiredNameRegistry, b: RetiredNameRegistry): boolean {
  if (a.exhaustedTiers !== b.exhaustedTiers || a.names.length !== b.names.length) {
    return false
  }
  const names = new Set(a.names)
  return b.names.every((name) => names.has(name))
}

function rekeyRetirementNamespaceHost(
  namespaces: Record<string, RetiredNameRegistry>,
  fromIdentity: string,
  toIdentity: string,
  retainSource: boolean
): boolean {
  const prefix = `${fromIdentity}:`
  let changed = false
  for (const key of Object.keys(namespaces)) {
    if (!key.startsWith(prefix)) {
      continue
    }
    const registry = namespaces[key]
    const nextKey = `${toIdentity}:${key.slice(prefix.length)}`
    const existing = namespaces[nextKey]
    // Compare membership, not size: folding a name into the watermark can hide a newly added name.
    const merged = existing ? mergeRetiredNameRegistries(existing, registry) : registry
    const wrote = !existing || !retiredNameRegistriesEqual(merged, existing)
    if (!retainSource) {
      delete namespaces[key]
      changed = true
    } else {
      // A retained source is still used by a live sibling; refresh LRU order even on a no-op merge, without scheduling a save.
      delete namespaces[key]
      namespaces[key] = registry
    }
    if (wrote) {
      // Assignment leaves old LRU order intact, making this newly merged destination eligible for eviction.
      delete namespaces[nextKey]
      namespaces[nextKey] = merged
      changed = true
    } else if (existing) {
      // A no-op merge still uses the destination; refresh order without scheduling a save.
      delete namespaces[nextKey]
      namespaces[nextKey] = existing
    }
  }
  return changed
}
