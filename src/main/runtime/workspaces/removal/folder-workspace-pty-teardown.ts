import type { WorktreeTeardownRuntime } from './worktree-teardown'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { killAllProcessesForWorktrees } from './worktree-batch-teardown'
import { worktreeRemovalTargetKey, type WorktreeRemovalTarget } from './worktree-removal-targets'

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
): Promise<boolean> {
  const target = { worktreeId, connectionId }
  return (
    (await teardownFolderWorkspacesPtys(deps, [target])).get(worktreeRemovalTargetKey(target)) ===
    true
  )
}

export async function teardownFolderWorkspacesPtys(
  deps: FolderWorkspacePtyTeardownDeps,
  targets: readonly WorktreeRemovalTarget[]
): Promise<ReadonlyMap<string, boolean>> {
  try {
    return await killAllProcessesForWorktrees(targets, {
      runtime: deps.runtime,
      localProvider: deps.getLocalProvider(),
      onPtyStopped: deps.onPtyStopped ?? undefined
    })
  } catch (error) {
    console.warn('[worktree-teardown] folder cleanup incomplete:', error)
    return new Map(targets.map((target) => [worktreeRemovalTargetKey(target), false]))
  }
}

export function bindFolderWorkspacePtyTeardown(deps: FolderWorkspacePtyTeardownDeps) {
  return {
    teardownFolderWorkspacePtys: (worktreeId: string, connectionId: string | null) =>
      teardownFolderWorkspacePtys(deps, worktreeId, connectionId),
    teardownFolderWorkspacesPtys: (targets: readonly WorktreeRemovalTarget[]) =>
      teardownFolderWorkspacesPtys(deps, targets)
  }
}
