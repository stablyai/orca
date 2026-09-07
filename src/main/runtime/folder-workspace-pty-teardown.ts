import { killAllProcessesForWorktree } from './worktree-teardown'
import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'

export type FolderWorkspacePtyTeardownDeps = {
  runtime: OrcaRuntimeService
  getSshProvider: ((connectionId: string) => IPtyProvider | undefined) | null
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
  const sshPtyProvider = connectionId ? deps.getSshProvider?.(connectionId) : undefined
  const ptyProvider = sshPtyProvider ?? deps.getLocalProvider()
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
    closeStructuredSessions: true,
    ...(connectionId
      ? { includeProviderInventory: Boolean(sshPtyProvider), includeLocalRegistry: false }
      : {})
  }).catch((error) => {
    console.warn(`[worktree-teardown] failed for ${worktreeId}:`, error)
  })
}
