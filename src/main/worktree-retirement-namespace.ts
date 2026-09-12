import { getRepoExecutionHostId, parseExecutionHostId } from '../shared/execution-host'
import {
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../shared/worktree/retired-name-registry'
import type { Repo } from '../shared/repo-types'
import { worktreePathComparisonKey } from './ipc/worktree-path-comparison'
import { sshEndpointKey, type SshIdentityFields } from './ssh/ssh-target-identity'

/**
 * Keys for `retiredWorktreeNamesByNamespace`, the copy of the retirement registry that survives a
 * project being removed and re-added.
 *
 * Primary storage stays on `repo.id` (see worktree-name-retirement.ts): the namespace is derived
 * from settings that a user can toggle at any time, so keying storage on it would orphan every
 * affected repo's retirements on a settings change. This map is the second, path-derived copy —
 * a settings toggle changes this key but `repo.id` still holds the tombstone, and a remove/re-add
 * loses the `repo.id` row but this key still matches.
 */

type RepoHostFields = Pick<Repo, 'connectionId' | 'executionHostId'>

export type SshTargetLookup = (targetId: string) => SshIdentityFields | undefined

/** No target row means no way to tell endpoints apart. The retirement contract prefers
 *  over-retiring (one name out of a 552-name pool) to reissuing a path whose agent history is
 *  still there, so unresolvable SSH repos share a bucket — still split by workspace path. */
export const UNKNOWN_SSH_HOST_IDENTITY = 'ssh:?'

/** Which machine and account a repo creates workspaces on. SSH resolves to the endpoint tuple
 *  rather than the target row id, because a removed and re-added host mints a fresh id while
 *  reaching the same filesystem. */
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

/** Rewrites a key's host identity, keeping its workspace-path half. Returns null when the key is
 *  not under `fromIdentity` or the swap is a no-op. */
function swapRetirementNamespaceHost(
  namespaceKey: string,
  fromIdentity: string,
  toIdentity: string
): string | null {
  const prefix = `${fromIdentity}:`
  return fromIdentity !== toIdentity && namespaceKey.startsWith(prefix)
    ? `${toIdentity}:${namespaceKey.slice(prefix.length)}`
    : null
}

/** The canonical key plus its pre-identity twin, whose host half was the SSH target row id. Reads
 *  cover both so an upgrade keeps the tombstones it already wrote; writes only use the first. */
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

/** The map deliberately outlives the repos that wrote it — that is what makes a re-add recover its
 *  tombstones — so nothing prunes it per repo. It is capped instead. */
export const MAX_RETIREMENT_NAMESPACES = 256

export function recordRetirementNamespaceRegistry(
  namespaces: Record<string, RetiredNameRegistry>,
  namespaceKey: string,
  registry: RetiredNameRegistry
): void {
  // Re-inserting moves the key to the end: JS keeps non-numeric string keys in insertion order and
  // JSON round-trips it, so the object's own order is the LRU list — no timestamp to persist.
  delete namespaces[namespaceKey]
  namespaces[namespaceKey] = registry
  trimRetirementNamespaces(namespaces)
}

/** Evicts oldest-first back to the cap. Every writer that can grow the map must end here — a copy
 *  during migration adds a key without removing one, so the map would otherwise drift over the cap
 *  and the next ordinary write would evict the whole excess at once.
 *
 *  Callers are responsible for re-inserting anything they touched first, so that insertion order
 *  actually reflects use. Exempting keys here instead would protect them for this one call and no
 *  other, leaving a just-written bucket sitting at the front of the eviction queue. */
function trimRetirementNamespaces(namespaces: Record<string, RetiredNameRegistry>): void {
  const keys = Object.keys(namespaces)
  // Why the clamp: a negative `end` makes slice count back from the tail, so an under-full map
  // would evict almost everything it holds instead of nothing.
  const overflow = Math.max(0, keys.length - MAX_RETIREMENT_NAMESPACES)
  for (const stale of keys.slice(0, overflow)) {
    delete namespaces[stale]
  }
}

export type RetirementNamespaceHostMigration = {
  /** Identities a single target row owned outright — its `ssh:<targetId>` host id. Reassignment
   *  leaves nothing pointing at them, so their namespaces move. */
  moveFrom?: readonly string[]
  /** Endpoint identities. These are deliberately *not* owned by the row that rotated: nothing stops
   *  a second target resolving to the same host|port|username, so the source bucket is kept.
   *  Copying costs one duplicated entry; moving would strip a live target's tombstones and reissue
   *  a path whose agent history is still on disk. */
  copyFrom?: readonly string[]
  to: string
}

/** Re-keys every namespace an SSH target used to reach onto its current identity, so a rotated
 *  target id does not strand the names it already spent. */
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
    // A retained source bucket grows the map, so migration has to respect the cap too.
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
    // Why compare: a copy repeats on every import, and reporting a change the destination already
    // covered would schedule a save each time. Compared by membership rather than by size, so a
    // destination that was stored uncompacted cannot trade a folded name for a new one and read
    // as unchanged.
    const merged = existing ? mergeRetiredNameRegistries(existing, registry) : registry
    const wrote = !existing || !retiredNameRegistriesEqual(merged, existing)
    if (!retainSource) {
      delete namespaces[key]
      changed = true
    } else {
      // Unconditional, even when the merge added nothing: a retained source is the bucket a live
      // sibling target still reads, so it counts as used. Gating this on a write would let the trim
      // take it ahead of buckets nothing has touched in months. Order only — never `changed`, or an
      // import that moved nothing would schedule a save.
      delete namespaces[key]
      namespaces[key] = registry
    }
    if (wrote) {
      // Re-insert rather than assign: assigning to an existing key leaves it in its original slot,
      // so a destination that was just written would sit at the front of the eviction queue and the
      // next ordinary write would drop it — taking the migrated name and its own with it.
      delete namespaces[nextKey]
      namespaces[nextKey] = merged
      changed = true
    } else if (existing) {
      // A move just made this destination the only copy, and a no-op copy is still a use. Same
      // reasoning as above, and likewise order only.
      delete namespaces[nextKey]
      namespaces[nextKey] = existing
    }
  }
  return changed
}
