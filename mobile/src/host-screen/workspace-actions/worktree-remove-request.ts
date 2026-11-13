import { worktreeRemovalReplyTimeoutMs } from '../../../../src/shared/worktree/archive-hook-removal-gate'
import { RECIPE_REMOVAL_REPLY_TIMEOUT_MS } from '../../../../src/shared/recipe-host-removal'
import type { Worktree } from '../../worktree/workspace-list-types'

export type WorktreeRemoveHooks = {
  runHooks: boolean
  allowFailedArchiveHook?: true
}

/** The phone's delete: a row the desktop tagged with its recipe environment also asks for that
 *  environment's destroy, which the delete sheet named. */
export function buildWorktreeRemoveRequest(
  item: Pick<Worktree, 'worktreeId' | 'recipeEnvironment'>,
  hooks: WorktreeRemoveHooks
): {
  params: WorktreeRemoveHooks & { worktree: string; force: true; destroyHost?: true }
  timeoutMs: number
} {
  const destroysEnvironment = item.recipeEnvironment !== undefined
  return {
    params: {
      worktree: `id:${item.worktreeId}`,
      force: true,
      ...hooks,
      ...(destroysEnvironment ? { destroyHost: true } : {})
    },
    // The host runs the archive hook, and here the recipe's destroy step, before it replies (#19334).
    timeoutMs: destroysEnvironment
      ? RECIPE_REMOVAL_REPLY_TIMEOUT_MS
      : worktreeRemovalReplyTimeoutMs(hooks.runHooks)
  }
}
