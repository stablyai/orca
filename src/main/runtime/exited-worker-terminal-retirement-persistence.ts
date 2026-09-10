import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import type { RuntimeStore } from './runtime-store-contract'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'

export type ExitedWorkerTerminalRetirement = {
  worktreeId: string
  paneKey: string
  surface?: RetiredTerminalSurface
}

type WorkspaceSessionStore = RuntimeStore & {
  getWorkspaceSession: NonNullable<RuntimeStore['getWorkspaceSession']>
  setWorkspaceSession: NonNullable<RuntimeStore['setWorkspaceSession']>
}

export async function persistExitedWorkerTerminalRetirement(args: {
  retirement: ExitedWorkerTerminalRetirement
  store: RuntimeStore | null
  getHostId: (worktreeId: string) => ExecutionHostId | null
}): Promise<boolean> {
  const { retirement, store } = args
  if (!store) {
    return true
  }
  if (
    !store.getWorkspaceSession ||
    !store.setWorkspaceSession ||
    (!store.flushPendingOrThrowAsync && !store.flushOrThrow)
  ) {
    return false
  }
  const sessionStore = store as WorkspaceSessionStore
  let hostId: ExecutionHostId | null
  try {
    hostId = args.getHostId(retirement.worktreeId)
  } catch (error) {
    console.warn('[orchestration] exited worker retirement owner is unavailable', {
      worktreeId: retirement.worktreeId,
      error
    })
    return false
  }
  const current = hostId ? sessionStore.getWorkspaceSession(hostId) : null
  if (!hostId || !current) {
    return false
  }
  const boundIncarnation = current.terminalPtyIncarnationsByPaneKey?.[retirement.paneKey]
  if (
    retirement.surface?.incarnationId &&
    boundIncarnation &&
    boundIncarnation !== retirement.surface.incarnationId
  ) {
    return false
  }
  let next = retirement.surface
    ? retireTerminalSurfaceFromPersistence(current, retirement.surface)
    : current
  const record = next.sleepingAgentSessionsByPaneKey?.[retirement.paneKey]
  if (record && runtimeWorktreeIdsEqual(record.worktreeId, retirement.worktreeId)) {
    const sleeping = { ...next.sleepingAgentSessionsByPaneKey }
    delete sleeping[retirement.paneKey]
    next = { ...next, sleepingAgentSessionsByPaneKey: sleeping }
  }
  if (next === current) {
    return true
  }
  let staged: WorkspaceSessionState | null = null
  try {
    sessionStore.setWorkspaceSession(next, hostId)
    staged = sessionStore.getWorkspaceSession(hostId)
    await flush(sessionStore)
    return true
  } catch (error) {
    rollbackFailedRetirement(sessionStore, hostId, current, staged)
    console.warn('[orchestration] failed to persist exited worker terminal retirement', {
      paneKey: retirement.paneKey,
      error
    })
    return false
  }
}

function rollbackFailedRetirement(
  store: WorkspaceSessionStore,
  hostId: ExecutionHostId,
  original: WorkspaceSessionState,
  staged: WorkspaceSessionState | null
): void {
  const latest = staged ? store.getWorkspaceSession(hostId) : null
  if (!staged || !latest) {
    return
  }
  const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(original, staged, latest)
  if (rolledBack !== latest) {
    store.setWorkspaceSession(rolledBack, hostId)
  }
}

async function flush(store: RuntimeStore): Promise<void> {
  if (store.flushPendingOrThrowAsync) {
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    return
  }
  if (store.flushOrThrow) {
    store.flushOrThrow()
    return
  }
  throw new Error('workspace_session_persistence_unavailable')
}
