import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { triggerTerminalSpawnPushTargetMaterialization } from '../../../runtime/runtime-terminal-spawn-push-target-materialization'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isWslMoveWorktreeBlocked } from '../../../persistence/moving-wsl-projects/wsl-move-background-backoff'

// Why (#17828): pty:spawn is the desktop GUI's own terminal path (new tab, split, reattach) --
// raw git commands can run here before any Orca-driven sync, so a deferred fork-PR remote must
// exist first. Mirrors the agent/background-terminal hook in
// runtime-terminal-spawn-push-target-materialization.ts, which this delegates to; fire-and-forget
// and a no-op once the remote already exists, so it is safe on every spawn including reattaches.
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
  // Why: never let a partial/fake Store (many pty:spawn unit tests supply a narrow one) or an
  // unexpected lookup failure turn this best-effort hook into a spawn-blocking exception.
  try {
    // A host-qualified read migrates a legacy row the move must keep frozen.
    if (isWslMoveWorktreeBlocked(args.worktreeId, LOCAL_EXECUTION_HOST_ID)) {
      return
    }
    // The local copy's own rows: a same-id twin on another host has its own push target.
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
