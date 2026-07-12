import type { Store } from '../persistence'
import type {
  RemovedSshTargetTombstone,
  SshRepoReadoption,
  SshTarget
} from '../../shared/ssh-types'

/**
 * Re-adoption of workspaces orphaned when an SSH target was removed.
 *
 * Repos/worktrees store only the (random) target id, so removing a target
 * strands them on a dead id. When the user re-adds the same host, a fresh id is
 * minted and nothing links the old workspaces to it. We bridge that gap using
 * removal-time tombstones ({ oldTargetId, configHost, host, username, port }):
 * on add/import we match the new target's identity to a tombstone and re-point
 * every repo/worktree from the old id to the new one.
 *
 * Matching is intentionally strict — configHost (alias) first, then the
 * host+username+port tuple — so we only auto-reattach on a confident identity
 * match and never mislink two genuinely different hosts. Anything that doesn't
 * match cleanly stays a ghost, handled by the forget flow instead.
 */

type IdentityFields = Pick<SshTarget, 'configHost' | 'host' | 'port' | 'username'>

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function tupleKey(fields: IdentityFields): string {
  return `${normalize(fields.host)}|${fields.port}|${normalize(fields.username)}`
}

// An alias only counts as a distinguishing identity when it differs from the
// host. addTarget defaults configHost to host, so a manual add with no real
// ssh-config alias has configHost === host — that's not an alias, it's just the
// hostname, and matching on it alone would ignore port/username.
function meaningfulAlias(fields: IdentityFields): string {
  const alias = normalize(fields.configHost)
  return alias && alias !== normalize(fields.host) ? alias : ''
}

function tombstoneMatches(tombstone: RemovedSshTargetTombstone, target: IdentityFields): boolean {
  const targetAlias = meaningfulAlias(target)
  const tombstoneAlias = meaningfulAlias(tombstone)
  // Primary: matching ssh-config alias. Stable across remove/re-import.
  if (targetAlias && tombstoneAlias) {
    // Both carry a real alias — the alias is the identity. Different aliases
    // mean deliberately distinct targets (e.g. prod-deploy vs prod-admin on the
    // same box with different identity files); do NOT fall through to the tuple,
    // or a second alias for the same endpoint would steal the first's workspaces.
    return targetAlias === tombstoneAlias
  }
  // Fallback: identical host+user+port. Used when either side has no real alias
  // (manual adds default configHost to host), so a different account or port on
  // the same host is correctly treated as a different target.
  return tupleKey(tombstone) === tupleKey(target)
}

/**
 * Re-point orphaned repos/worktrees onto `newTarget` if a removed target with
 * the same host identity is tombstoned. Consumes the matching tombstone(s).
 * Returns exact repo/target migrations so the renderer can discard only rows
 * proven to be stale after its per-host catalog merge.
 */
export function readoptOrphanedWorkspacesForTarget(
  store: Store,
  newTarget: SshTarget
): SshRepoReadoption[] {
  const tombstones = store.getRemovedSshTargetTombstones()
  if (tombstones.length === 0) {
    return []
  }
  const readoptions: SshRepoReadoption[] = []
  for (const tombstone of tombstones) {
    // Why: a re-added target can't share the id of one that still exists, but
    // guard anyway so we never re-point a live target onto itself.
    if (tombstone.oldTargetId === newTarget.id) {
      store.removeRemovedSshTargetTombstone(tombstone.oldTargetId)
      continue
    }
    if (!tombstoneMatches(tombstone, newTarget)) {
      continue
    }
    const repoIds = store.reassignSshTargetId(tombstone.oldTargetId, newTarget.id)
    if (repoIds.length > 0) {
      readoptions.push({ oldTargetId: tombstone.oldTargetId, newTargetId: newTarget.id, repoIds })
    }
    // Consume the tombstone whether or not it re-pointed anything: the host has
    // returned, so the record has served its purpose.
    store.removeRemovedSshTargetTombstone(tombstone.oldTargetId)
  }
  return readoptions
}

/** Build a tombstone from a target about to be removed. */
export function buildRemovedSshTargetTombstone(
  target: SshTarget,
  removedAt: number
): RemovedSshTargetTombstone {
  return {
    oldTargetId: target.id,
    ...(target.configHost ? { configHost: target.configHost } : {}),
    host: target.host,
    port: target.port,
    username: target.username,
    label: target.label,
    removedAt
  }
}
