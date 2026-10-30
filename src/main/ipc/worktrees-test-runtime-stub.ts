import { _resetPendingWorktreeRemovalsForTests } from '../worktree-background-removal'
import { vi } from 'vitest'
import { WorkspaceLifecycleQueue } from '../runtime/workspaces/workspace-lifecycle-queue'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'

export type WorktreeRuntimeStub = {
  resolveRemoteTrackingBase: ReturnType<typeof vi.fn>
  hasRemoteTrackingRef: ReturnType<typeof vi.fn>
  getOrStartRemoteTrackingBaseRefresh: ReturnType<typeof vi.fn>
  getOrStartRemoteFetch: ReturnType<typeof vi.fn>
  fetchRemoteWithCache: ReturnType<typeof vi.fn>
  emitWorktreeBaseStatus: ReturnType<typeof vi.fn>
  recordOptimisticReconcileToken: ReturnType<typeof vi.fn>
  reconcileWorktreeBaseStatus: ReturnType<typeof vi.fn>
  clearOptimisticReconcileToken: ReturnType<typeof vi.fn>
  releaseRemovedWorktreeHostSessions: ReturnType<typeof vi.fn>
  resolveManagedMrBase: ReturnType<typeof vi.fn>
  getSetupTerminalTitle: ReturnType<typeof vi.fn>
  createTerminal: ReturnType<typeof vi.fn>
  invalidateWorktreeCatalog: ReturnType<typeof vi.fn>
  splitTerminal: ReturnType<typeof vi.fn>
  notifyWorktreesChangedForRemoteClients: ReturnType<typeof vi.fn>
  closeFileWatchersForRemoval: ReturnType<typeof vi.fn>
  acquireFileWatcherRemoval: ReturnType<typeof vi.fn>
  hydrateInferredWorktreeLineage: ReturnType<typeof vi.fn>
  publishWorktreeRemovalChange: ReturnType<typeof vi.fn>
  workspaceLifecycle: WorkspaceLifecycleQueue | null
}

/** Minimal create-flow runtime; fetch-remote-cache.test.ts covers actual fetch caching. */
export function createWorktreeRuntimeStub(mainWindow?: {
  webContents: { send: (channel: string, ...args: unknown[]) => unknown }
}): WorktreeRuntimeStub {
  // Reset removals whenever the harness builds a runtime to prevent cross-test leaks.
  _resetPendingWorktreeRemovalsForTests()
  const runtimeStub: WorktreeRuntimeStub = {
    workspaceLifecycle: ORCA_SIDEBAR_INPUTS_IS_MAIN ? new WorkspaceLifecycleQueue() : null,
    resolveRemoteTrackingBase: vi.fn().mockResolvedValue(null),
    hasRemoteTrackingRef: vi.fn().mockResolvedValue(false),
    getOrStartRemoteTrackingBaseRefresh: vi.fn().mockResolvedValue({ ok: true }),
    getOrStartRemoteFetch: vi.fn().mockResolvedValue({ ok: true }),
    fetchRemoteWithCache: vi.fn().mockResolvedValue(undefined),
    emitWorktreeBaseStatus: vi.fn(),
    recordOptimisticReconcileToken: vi.fn().mockReturnValue('token-1'),
    reconcileWorktreeBaseStatus: vi.fn(),
    clearOptimisticReconcileToken: vi.fn(),
    releaseRemovedWorktreeHostSessions: vi.fn(),
    resolveManagedMrBase: vi.fn().mockResolvedValue({ baseBranch: 'origin/mr-branch' }),
    getSetupTerminalTitle: vi.fn().mockReturnValue('Setup'),
    createTerminal: vi.fn().mockResolvedValue({
      handle: 'term-startup',
      worktreeId: 'repo-1::/workspace/improve-dashboard',
      title: null,
      surface: 'visible'
    }),
    invalidateWorktreeCatalog: vi.fn(),
    splitTerminal: vi.fn().mockResolvedValue({
      handle: 'term-setup',
      tabId: 'tab-startup',
      paneRuntimeId: -1
    }),
    notifyWorktreesChangedForRemoteClients: vi.fn(),
    closeFileWatchersForRemoval: vi.fn().mockResolvedValue(undefined),
    acquireFileWatcherRemoval: vi.fn(),
    hydrateInferredWorktreeLineage: vi.fn().mockResolvedValue(undefined),
    publishWorktreeRemovalChange: vi.fn((repoId: string) => {
      mainWindow?.webContents.send('worktrees:changed', { repoId })
    })
  }
  runtimeStub.acquireFileWatcherRemoval.mockImplementation(
    async (worktreePath: string, connectionId?: string) => {
      await (
        runtimeStub.closeFileWatchersForRemoval as (
          worktreePath: string,
          connectionId?: string
        ) => Promise<void>
      )(worktreePath, connectionId)
      return {
        finish: vi.fn().mockResolvedValue(undefined)
      }
    }
  )
  return runtimeStub
}
