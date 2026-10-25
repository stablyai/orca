import { killAllProcessesForWorktree, type WorktreeTeardownRuntime } from './worktree-teardown'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { teardownStops } from './owned-session-teardown-policy'

export type FolderWorkspacePtyTeardownDeps = {
  runtime: WorktreeTeardownRuntime
  getLocalProvider: () => IPtyProvider | null
  onPtyStopped: ((ptyId: string) => void) | null
}

/** Removal must proceed even when PTY teardown is stuck or its host is unreachable. */
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
    // PTY sweeps miss structured chats; close them too before forgetting the workspace.
    closeStructuredSessions: teardownStops('folder-removal', 'structured-chat'),
    ...(connectionId ? { includeProviderInventory: false, includeLocalRegistry: false } : {})
  }).catch((error) => {
    console.warn(`[worktree-teardown] failed for ${worktreeId}:`, error)
  })
}
