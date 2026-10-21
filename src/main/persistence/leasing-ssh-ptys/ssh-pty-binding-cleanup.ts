import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'

export type SshPtyBindingCleanupOperations = {
  state: PersistedState
  toComparablePtyId: (targetId: string, ptyId: string) => string
  scheduleSave: () => void
}

/** `binding.ptyId` must already be in lease-comparable (relay) form; callers normalize it. */
function sshRemotePtyLeaseMayReferenceBinding(
  lease: SshRemotePtyLease,
  binding: {
    ptyId: string
    targetId: string
    worktreeId?: string
    tabId?: string
    leafId?: string
  }
): boolean {
  if (lease.targetId !== binding.targetId || lease.ptyId !== binding.ptyId) {
    return false
  }
  // Why: target removal is destructive; scrub matching bindings before deleting the lease, else removing the tombstone can revive stale PTY ids.
  return (
    (binding.worktreeId === undefined ||
      lease.worktreeId === undefined ||
      lease.worktreeId === binding.worktreeId) &&
    (binding.tabId === undefined || lease.tabId === undefined || lease.tabId === binding.tabId) &&
    (binding.leafId === undefined || lease.leafId === undefined || lease.leafId === binding.leafId)
  )
}

export function clearSshRemotePtyBindingsForTarget(
  operations: SshPtyBindingCleanupOperations,
  targetId: string
): void {
  const leases = operations.state.sshRemotePtyLeases?.filter((lease) => lease.targetId === targetId)
  clearSshRemotePtyBindingsForLeases(operations, targetId, leases ?? [])
}

export function clearSshRemotePtyBindingsForLeases(
  operations: SshPtyBindingCleanupOperations,
  targetId: string,
  leases: SshRemotePtyLease[]
): boolean {
  if (!leases?.length) {
    return false
  }
  // Keyed by the stored (relay) pty id, which is the only form a lease holds; every lookup below
  // normalizes the binding id to that form first, so a bucket miss means "no lease names this pty"
  // and the binding is KEPT. Failing closed here leaves a stale id to be retired on reattach,
  // where clearing on a bad match would strand a live remote shell behind a respawned pane.
  let leasesByPtyId: Map<string, SshRemotePtyLease[]> | undefined
  const referencesBinding = (
    binding: Parameters<typeof sshRemotePtyLeaseMayReferenceBinding>[1]
  ): boolean => {
    if (!leasesByPtyId) {
      leasesByPtyId = new Map()
      for (const lease of leases) {
        if (lease.targetId !== targetId) {
          continue
        }
        const entries = leasesByPtyId.get(lease.ptyId)
        if (entries) {
          entries.push(lease)
        } else {
          leasesByPtyId.set(lease.ptyId, [lease])
        }
      }
    }
    const ptyId = operations.toComparablePtyId(binding.targetId, binding.ptyId)
    return (leasesByPtyId.get(ptyId) ?? []).some((lease) =>
      sshRemotePtyLeaseMayReferenceBinding(lease, { ...binding, ptyId })
    )
  }
  let changed = false
  const sessions = new Set(
    [
      operations.state.workspaceSession,
      operations.state.workspaceSessionsByHostId?.[toSshExecutionHostId(targetId)]
    ].filter((session): session is WorkspaceSessionState => Boolean(session))
  )
  for (const session of sessions) {
    for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (
          tab.ptyId &&
          referencesBinding({ ptyId: tab.ptyId, worktreeId, targetId, tabId: tab.id })
        ) {
          tab.ptyId = null
          changed = true
        }
      }
    }
    const worktreeIdByTabId = new Map<string, string>()
    for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (!worktreeIdByTabId.has(tab.id)) {
          worktreeIdByTabId.set(tab.id, worktreeId)
        }
      }
    }
    for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
      const bindings = layout.ptyIdsByLeafId
      if (!bindings) {
        continue
      }
      const worktreeId = worktreeIdByTabId.get(tabId)
      const nextBindings = Object.fromEntries(
        Object.entries(bindings).filter(
          ([leafId, ptyId]) => !referencesBinding({ ptyId, targetId, worktreeId, tabId, leafId })
        )
      )
      if (Object.keys(nextBindings).length !== Object.keys(bindings).length) {
        layout.ptyIdsByLeafId = nextBindings
        changed = true
      }
    }
  }
  if (changed) {
    operations.scheduleSave()
  }
  return changed
}
