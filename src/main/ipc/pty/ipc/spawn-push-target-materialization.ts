import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { triggerTerminalSpawnPushTargetMaterialization } from '../../../runtime/runtime-terminal-spawn-push-target-materialization'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isWslMoveWorktreeBlocked } from '../../../persistence/moving-wsl-projects/wsl-move-background-backoff'

// GUI terminals can run Git before Orca sync; request deferred push-target setup on spawn and reattach (#17828).
export function triggerPtySpawnPushTargetMaterialization(
  deps: PtySpawnIpcDeps,
  args: PtySpawnIpcArgs
): void {
  // An SSH pane's git runs on its host, not here.
  if (!args.worktreeId || !deps.store || args.connectionId) {
    return
  }
  const parsed = splitWorktreeIdForFilesystem(args.worktreeId)
  if (!parsed) {
    return
  }
  // Partial stores and failed lookups must not turn this best-effort hook into a spawn failure.
  try {
    // Host-qualified reads can migrate legacy rows; leave moving WSL rows frozen.
    if (isWslMoveWorktreeBlocked(args.worktreeId, LOCAL_EXECUTION_HOST_ID)) {
      return
    }
    // Same-ID twins on another host have independent push targets.
    const pushTarget = (
      deps.store.getWorktreeMetaForHost
        ? deps.store.getWorktreeMetaForHost(args.worktreeId, LOCAL_EXECUTION_HOST_ID)
        : deps.store.getWorktreeMeta?.(args.worktreeId)
    )?.pushTarget
    const repo =
      deps.store
        .getRepos?.()
        .find(
          (candidate) =>
            candidate.id === parsed.repoId &&
            getRepoExecutionHostId(candidate) === LOCAL_EXECUTION_HOST_ID
        ) ??
      deps.store.getRepo?.(parsed.repoId) ??
      null
    triggerTerminalSpawnPushTargetMaterialization(
      parsed.worktreePath,
      pushTarget,
      repo,
      deps.store,
      parsed.repoId,
      args.worktreeId
    )
  } catch (error) {
    console.warn(
      `[pty-spawn] failed to trigger push target materialization for ${args.worktreeId}:`,
      error
    )
  }
}
