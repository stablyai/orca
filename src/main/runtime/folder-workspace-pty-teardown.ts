import { killAllProcessesForWorktree, type WorktreeTeardownRuntime } from './worktree-teardown'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { teardownStops } from './owned-session-teardown-policy'

export type FolderWorkspacePtyTeardownDeps = {
  runtime: WorktreeTeardownRuntime
  getLocalProvider: () => IPtyProvider | null
  onPtyStopped: ((ptyId: string) => void) | null
}

/**
 * Best-effort PTY sweep for a folder workspace being removed. Never throws:
 * a stuck or unreachable host must not block forgetting the workspace.
 */
export async function teardownFolderWorkspacePtys(
  deps: FolderWorkspacePtyTeardownDeps,
  worktreeId: string,
  connectionId: string | null
): Promise<void> {
  const ptyProvider = deps.getLocalProvider()
  if (!ptyProvider) {
    return
  }
  await killAllProcessesForWorktree(worktreeId, {
    runtime: deps.runtime,
    resolvedWorktreeId: worktreeId,
    ...(connectionId ? { resolvedConnectionId: connectionId } : {}),
    localProvider: ptyProvider,
    onPtyStopped: deps.onPtyStopped ?? undefined,
    // A structured session is on no PTY surface, so the sweeps above leave it attached to a
    // workspace this removal is about to forget. Closed best-effort, exactly like those PTYs.
    closeStructuredSessions: teardownStops('folder-removal', 'structured-chat'),
    ...(connectionId ? { includeProviderInventory: false, includeLocalRegistry: false } : {})
  }).catch((error) => {
    console.warn(`[worktree-teardown] failed for ${worktreeId}:`, error)
  })
}
