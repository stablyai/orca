import { cleanupUnusedWorktreePushTargetRemote } from '../../../ipc/worktree-remote'
import type { RuntimeLocalWorktreeRemovalFinishArgs } from './runtime-registered-local-worktree-removal'

export async function cleanupRemovedWorktreePushTarget(
  args: RuntimeLocalWorktreeRemovalFinishArgs
): Promise<void> {
  const { repo, target, removedPushTarget: pushTarget, store, localOptions: options } = args
  await cleanupUnusedWorktreePushTargetRemote(repo.path, target.id, pushTarget, store, options)
}
