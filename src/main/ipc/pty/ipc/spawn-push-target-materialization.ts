import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { triggerTerminalSpawnPushTargetMaterialization } from '../../../runtime/runtime-terminal-spawn-push-target-materialization'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

// Why (#17828): pty:spawn is the desktop GUI's own terminal path (new tab, split, reattach) --
// raw git commands can run here before any Orca-driven sync, so a deferred fork-PR remote must
// exist first. Mirrors the agent/background-terminal hook in
// runtime-terminal-spawn-push-target-materialization.ts, which this delegates to; fire-and-forget
// and a no-op once the remote already exists, so it is safe on every spawn including reattaches.
export function triggerPtySpawnPushTargetMaterialization(
  deps: PtySpawnIpcDeps,
  args: PtySpawnIpcArgs
): void {
  if (!args.worktreeId || !deps.store) {
    return
  }
  const parsed = splitWorktreeIdForFilesystem(args.worktreeId)
  if (!parsed) {
    return
  }
  // Why: never let a partial/fake Store (many pty:spawn unit tests supply a narrow one) or an
  // unexpected lookup failure turn this best-effort hook into a spawn-blocking exception.
  try {
    const pushTarget = deps.store.getWorktreeMeta?.(args.worktreeId)?.pushTarget
    const repo = deps.store.getRepo?.(parsed.repoId) ?? null
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
