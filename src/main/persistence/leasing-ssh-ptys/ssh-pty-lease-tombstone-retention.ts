import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'

export type SshPtyLeaseTombstoneRetentionOperations = {
  state: PersistedState
  toComparablePtyId: (targetId: string, ptyId: string) => string
}

/** Expired means route loss, not exit; its tombstone prevents orphan cleanup from killing a live shell. */
function isRetiredRoutingTombstone(lease: SshRemotePtyLease, targetId: string): boolean {
  return (
    lease.targetId === targetId && lease.state === 'terminated' && lease.pendingKill === undefined
  )
}

/** Scan every partition before deletion, including ones the targeted binding scrub cannot reach. */
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

/** Prune only unreachable terminated leases without pending kills; moved tabs may evade the prior scrub.
 * Pending kills remain for older builds. Terminated leases no longer claim metadata ownership. */
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
