import type { WorkspaceSnooze } from '../../shared/workspace-snooze'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { WorktreeMetaPreconditionError } from '../runtime/runtime-managed-worktree-metadata'
import { WorkspaceSnoozeWakeService, type SnoozedWorkspace } from './workspace-snooze-wake-service'

type WakeUpdates = { snooze: null; isUnread: true; lastActivityAt: number }

/** The slice of the profile store the wake service reads. */
export type WorkspaceSnoozeStore = {
  getAllWorktreeMeta(): Record<string, Pick<WorktreeMeta, 'snooze'>>
  getWorktreeMeta(worktreeId: string): Pick<WorktreeMeta, 'snooze'> | undefined
  getFolderWorkspaces(): Pick<FolderWorkspace, 'id' | 'snooze'>[]
  getFolderWorkspace(id: string): Pick<FolderWorkspace, 'snooze'> | undefined
}

/** The slice of the runtime the wake service writes through. */
export type WorkspaceSnoozeWakeRuntime = {
  updateManagedWorktreeMeta(
    selector: string,
    updates: WakeUpdates,
    precondition: (current: Pick<WorktreeMeta, 'snooze'> | undefined) => boolean
  ): Promise<unknown>
  updateFolderWorkspace(id: string, updates: WakeUpdates): Promise<unknown>
}

export function createWorkspaceSnoozeWakeService(
  store: WorkspaceSnoozeStore,
  runtime: WorkspaceSnoozeWakeRuntime
): WorkspaceSnoozeWakeService {
  return new WorkspaceSnoozeWakeService({
    listSnoozed: () => listSnoozedWorkspaces(store),
    wake: async (workspace, now) => {
      // Why re-read with no await before the write: the user may have re-snoozed or woken it
      // since the pass listed it, and clearing that newer snooze would lose their choice.
      const unchanged = (snooze: WorkspaceSnooze | null | undefined): boolean =>
        snooze?.snoozedAt === workspace.snooze.snoozedAt
      if (!unchanged(readStoredSnooze(store, workspace))) {
        return
      }
      const updates: WakeUpdates = { snooze: null, isUnread: true, lastActivityAt: now }
      // Why the runtime and not the store: it routes host-qualified rows and notifies every client.
      if (workspace.kind === 'folder-workspace') {
        await runtime.updateFolderWorkspace(workspace.id, updates)
        return
      }
      try {
        // Why a precondition too: the runtime awaits worktree resolution before it writes.
        await runtime.updateManagedWorktreeMeta(`id:${workspace.id}`, updates, (meta) =>
          unchanged(meta?.snooze)
        )
      } catch (error) {
        if (!(error instanceof WorktreeMetaPreconditionError)) {
          throw error
        }
      }
    }
  })
}

function readStoredSnooze(
  store: WorkspaceSnoozeStore,
  workspace: SnoozedWorkspace
): WorkspaceSnooze | null | undefined {
  return workspace.kind === 'worktree'
    ? store.getWorktreeMeta(workspace.id)?.snooze
    : store.getFolderWorkspace(workspace.id)?.snooze
}

function listSnoozedWorkspaces(store: WorkspaceSnoozeStore): SnoozedWorkspace[] {
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
