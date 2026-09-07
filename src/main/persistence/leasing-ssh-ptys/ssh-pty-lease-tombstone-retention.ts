import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'

export type SshPtyLeaseTombstoneRetentionOperations = {
  state: PersistedState
  toComparablePtyId: (targetId: string, ptyId: string) => string
}

/** A routing tombstone with nothing left to route: the operator closed this PTY and no stop is
 *  still owed for it. `expired` is deliberately not here — it says only that the CLIENT lost its
 *  route (docs/reference/ssh-execution-boundary.md), and `sweepOrphanedRelayPtys` reads those ids
 *  as its leave-alone list, so deleting one would authorize stopping a remote shell that
 *  supersession left running on purpose. */
function isRetiredRoutingTombstone(lease: SshRemotePtyLease, targetId: string): boolean {
  return (
    lease.targetId === targetId && lease.state === 'terminated' && lease.pendingKill === undefined
  )
}

/** Every stored-form relay pty id some persisted pane binding still names for this target.
 *
 *  Reads all partitions, not only the two `clearSshRemotePtyBindingsForLeases` scrubs: this answer
 *  authorizes a delete, so a partition left unscanned would be a binding whose tombstone we dropped.
 */
function boundRelayPtyIds(
  operations: SshPtyLeaseTombstoneRetentionOperations,
  targetId: string
): Set<string> {
  const bound = new Set<string>()
  const sessions = [
    operations.state.workspaceSession,
    ...Object.values(operations.state.workspaceSessionsByHostId ?? {})
  ]
  for (const session of sessions) {
    if (!session) {
      continue
    }
    for (const tabs of Object.values(session.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (tab.ptyId) {
          bound.add(operations.toComparablePtyId(targetId, tab.ptyId))
        }
      }
    }
    for (const layout of Object.values(session.terminalLayoutsByTabId ?? {})) {
      for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
        bound.add(operations.toComparablePtyId(targetId, ptyId))
      }
    }
  }
  return bound
}

/**
 * Deletes the `terminated` rows nothing can reach, bounding an array that otherwise only grew.
 *
 * `terminated` is written with a binding scrub in the same call, so once no persisted binding names
 * the id the row answers no question any reader asks. Reattach refuses it
 * (`sshRemotePtyLeaseAllowsReattach`), pane recovery matches on `expired` only, the orphan sweep
 * already classes it neither routed nor expired, and `ssh:reset` / `ssh:terminateSessions` skip it
 * outright — every one of those behaves identically on an absent row. The one reader that can still
 * observe it is `isRestorablePtyBinding`, and only through a binding whose pty id matches, which is
 * exactly what the reachability test rules out. A `pendingKill` is an undelivered stop, so those
 * rows stay until the replay retires them.
 *
 * The reachability test is not redundant with the scrub: a lease freezes its `tabId`, so a pane
 * broken out into a new tab leaves a binding the scrub's tab-qualified match no longer reaches.
 *
 * Does not re-arm the local-worktree-metadata prune gate: a `terminated` lease no longer counts as
 * a persisted workspace owner, so dropping one cannot make any metadata row more removable.
 */
export function pruneRetiredSshRemotePtyLeaseTombstones(
  operations: SshPtyLeaseTombstoneRetentionOperations,
  targetId: string
): boolean {
  const leases = operations.state.sshRemotePtyLeases ?? []
  if (!leases.some((lease) => isRetiredRoutingTombstone(lease, targetId))) {
    return false
  }
  const bound = boundRelayPtyIds(operations, targetId)
  const retained = leases.filter(
    (lease) => !isRetiredRoutingTombstone(lease, targetId) || bound.has(lease.ptyId)
  )
  if (retained.length === leases.length) {
    return false
  }
  operations.state.sshRemotePtyLeases = retained
  return true
}
