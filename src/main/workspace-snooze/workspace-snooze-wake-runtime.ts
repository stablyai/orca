import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { WorkspaceSnoozeWakeService, type SnoozedWorkspace } from './workspace-snooze-wake-service'

export function createWorkspaceSnoozeWakeService(
  store: Store,
  runtime: OrcaRuntimeService
): WorkspaceSnoozeWakeService {
  return new WorkspaceSnoozeWakeService({
    listSnoozed: () => listSnoozedWorkspaces(store),
    wake: async (workspace, now) => {
      const updates = { snooze: null, isUnread: true, lastActivityAt: now }
      // Why the runtime and not the store: it routes host-qualified rows and notifies every client.
      await (workspace.kind === 'worktree'
        ? runtime.updateManagedWorktreeMeta(`id:${workspace.id}`, updates)
        : runtime.updateFolderWorkspace(workspace.id, updates))
    }
  })
}

function listSnoozedWorkspaces(store: Store): SnoozedWorkspace[] {
  const snoozed: SnoozedWorkspace[] = []
  for (const [id, meta] of Object.entries(store.getAllWorktreeMeta())) {
    if (meta.snooze) {
      snoozed.push({ kind: 'worktree', id, snooze: meta.snooze })
    }
  }
  for (const folderWorkspace of store.getFolderWorkspaces()) {
    if (folderWorkspace.snooze) {
      snoozed.push({
        kind: 'folder-workspace',
        id: folderWorkspace.id,
        snooze: folderWorkspace.snooze
      })
    }
  }
  return snoozed
}
