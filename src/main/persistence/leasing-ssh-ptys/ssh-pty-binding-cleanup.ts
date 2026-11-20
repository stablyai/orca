import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import type { SshRemotePtyLease } from '../../../shared/remote-runtime/ssh/ssh-types'
import { toSshExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'

export type SshPtyBindingCleanupOperations = {
  state: PersistedState
  toComparablePtyId: (targetId: string, ptyId: string) => string
  scheduleSave: () => void
}

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
  // Normalize binding IDs before lookup; preserve unmatched bindings to avoid stranding live shells.
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
  const hostId = toSshExecutionHostId(targetId)
  const clearBindings = (session: WorkspaceSessionState): WorkspaceSessionState => {
    let next = session
    // Replace, never edit, saved entries: incremental saves compare them by identity.
    let rows: WorkspaceSessionState['tabsByWorktree'] | undefined
    for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      const bound = (tab: (typeof tabs)[number]): boolean =>
        Boolean(
          tab.ptyId && referencesBinding({ ptyId: tab.ptyId, worktreeId, targetId, tabId: tab.id })
        )
      if (tabs.some(bound)) {
        const nextTabs = tabs.map((tab) => (bound(tab) ? { ...tab, ptyId: null } : tab))
        rows ??= { ...session.tabsByWorktree }
        rows[worktreeId] = nextTabs
        changed = true
      }
    }
    if (rows) {
      next = { ...next, tabsByWorktree: rows }
    }
    const worktreeIdByTabId = new Map<string, string>()
    for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (!worktreeIdByTabId.has(tab.id)) {
          worktreeIdByTabId.set(tab.id, worktreeId)
        }
      }
    }
    let layouts: WorkspaceSessionState['terminalLayoutsByTabId'] | undefined
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
        layouts ??= { ...session.terminalLayoutsByTabId }
        layouts[tabId] = { ...layout, ptyIdsByLeafId: nextBindings }
        changed = true
      }
    }
    if (layouts) {
      next = { ...next, terminalLayoutsByTabId: layouts }
    }
    return next
  }
  // Publish replacements: rollback of an in-flight session write keeps the previous objects.
  operations.state.workspaceSession = clearBindings(operations.state.workspaceSession)
  const partition = operations.state.workspaceSessionsByHostId?.[hostId]
  const clearedPartition = partition && clearBindings(partition)
  if (clearedPartition && clearedPartition !== partition) {
    operations.state.workspaceSessionsByHostId = {
      ...operations.state.workspaceSessionsByHostId,
      [hostId]: clearedPartition
    }
  }
  if (changed) {
    operations.scheduleSave()
  }
  return changed
}
