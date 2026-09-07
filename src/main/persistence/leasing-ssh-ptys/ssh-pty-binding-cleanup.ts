import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'

export type SshPtyBindingCleanupOperations = {
  state: PersistedState
  toComparablePtyId: (targetId: string, ptyId: string) => string
  scheduleSave: () => void
}

function sshRemotePtyLeaseMayReferenceBinding(
  operations: SshPtyBindingCleanupOperations,
  lease: SshRemotePtyLease,
  binding: {
    ptyId: string
    targetId: string
    worktreeId?: string
    tabId?: string
    leafId?: string
  }
): boolean {
  const bindingPtyId = operations.toComparablePtyId(binding.targetId, binding.ptyId)
  if (lease.targetId !== binding.targetId || lease.ptyId !== bindingPtyId) {
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
          leases.some((lease) =>
            sshRemotePtyLeaseMayReferenceBinding(operations, lease, {
              ptyId: tab.ptyId!,
              worktreeId,
              targetId,
              tabId: tab.id
            })
          )
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
          ([leafId, ptyId]) =>
            !leases.some((lease) =>
              sshRemotePtyLeaseMayReferenceBinding(operations, lease, {
                ptyId,
                targetId,
                worktreeId,
                tabId,
                leafId
              })
            )
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
