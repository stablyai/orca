import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSnooze } from '../../shared/workspace-snooze'
import {
  createWorkspaceSnoozeWakeService,
  type WorkspaceSnoozeStore,
  type WorkspaceSnoozeWakeRuntime
} from './workspace-snooze-wake-runtime'

const NOW = 10_000
const dueSnooze: WorkspaceSnooze = { snoozedAt: 1, wakeAt: 5_000 }

function createHarness() {
  const worktreeMeta: Record<string, { snooze?: WorkspaceSnooze | null }> = {}
  const folderWorkspaces = new Map<string, { id: string; snooze?: WorkspaceSnooze | null }>()
  const store: WorkspaceSnoozeStore = {
    getAllWorktreeMeta: () => worktreeMeta,
    getWorktreeMeta: (id) => worktreeMeta[id],
    getFolderWorkspaces: () => [...folderWorkspaces.values()],
    getFolderWorkspace: (id) => folderWorkspaces.get(id)
  }
  const runtime = {
    updateManagedWorktreeMeta: vi.fn<WorkspaceSnoozeWakeRuntime['updateManagedWorktreeMeta']>(
      async () => null
    ),
    updateFolderWorkspace: vi.fn<WorkspaceSnoozeWakeRuntime['updateFolderWorkspace']>(
      async () => null
    )
  }
  const service = createWorkspaceSnoozeWakeService(store, runtime)
  return { worktreeMeta, folderWorkspaces, runtime, service }
}

describe('createWorkspaceSnoozeWakeService', () => {
  // Why before construction: the service captures `Date.now` when it is built.
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('wakes due worktrees and folder workspaces through the runtime', async () => {
    const { worktreeMeta, folderWorkspaces, runtime, service } = createHarness()
    worktreeMeta['repo::/due'] = { snooze: dueSnooze }
    folderWorkspaces.set('folder-1', { id: 'folder-1', snooze: dueSnooze })

    await service.wakeDue()

    const updates = { snooze: null, isUnread: true, lastActivityAt: NOW }
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith('id:repo::/due', updates)
    expect(runtime.updateFolderWorkspace).toHaveBeenCalledWith('folder-1', updates)
  })

  it('skips a workspace the user re-snoozed or woke after the pass listed it', async () => {
    const { worktreeMeta, folderWorkspaces, runtime, service } = createHarness()
    worktreeMeta['repo::/first'] = { snooze: dueSnooze }
    folderWorkspaces.set('re-snoozed', { id: 're-snoozed', snooze: dueSnooze })
    folderWorkspaces.set('woken', { id: 'woken', snooze: dueSnooze })
    // The first wake yields mid-pass, which is when a user edit can land.
    runtime.updateManagedWorktreeMeta.mockImplementationOnce(async () => {
      folderWorkspaces.set('re-snoozed', {
        id: 're-snoozed',
        snooze: { snoozedAt: 9_000, wakeAt: 50_000 }
      })
      folderWorkspaces.set('woken', { id: 'woken', snooze: null })
      return null
    })

    await service.wakeDue()

    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledOnce()
    expect(runtime.updateFolderWorkspace).not.toHaveBeenCalled()
  })
})
