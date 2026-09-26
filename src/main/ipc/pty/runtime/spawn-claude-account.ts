import { isClaudeLaunchCommand } from '../host-env/fresh-spawn-routing'
import {
  isFreshClaudeLaunch,
  preparePinnableClaudeAuth,
  markClaudePtySpawnedForAuth
} from '../claude-pinned-spawn'
import { resolveProjectClaudeAccount } from '../../../claude-accounts/project-claude-account-resolution'
import type { RuntimePtySpawnState } from './spawn-state'

/**
 * The `--account` a fresh runtime spawn must run on, refused where a pinned launch cannot run.
 * With no explicit `--account`, falls back to the launch config's recorded choice, then the
 * project's saved default; that fallback never throws, since it never applies to SSH or non-Claude
 * launches.
 */
export function resolveRuntimeSpawnClaudeAccount(ctx: RuntimePtySpawnState): string | undefined {
  if (ctx.preAdoptedStablePane) {
    return undefined
  }
  const explicit = ctx.args.claudeAccountId
  if (explicit) {
    if (ctx.args.connectionId) {
      throw new Error('Claude --account launches are not supported for SSH workspaces.')
    }
    if (!isClaudeLaunchCommand(ctx.args.command) && ctx.args.launchAgent !== 'claude') {
      throw new Error('--account applies only to Claude launches.')
    }
    return explicit
  }
  if (
    ctx.args.connectionId ||
    !isFreshClaudeLaunch({ ...ctx.args, preAdoptedStablePane: false }, undefined, {
      trustLaunchAgent: true
    })
  ) {
    return undefined
  }
  return resolveProjectClaudeAccount({
    getRepo: (repoId) => ctx.deps.store?.getRepo?.(repoId),
    worktreeId: ctx.args.worktreeId,
    launchConfigAccountId: ctx.args.launchConfigClaudeAccountId
  })
}

export function isRuntimeClaudeLaunch(
  ctx: RuntimePtySpawnState,
  pinnedAccountId: string | undefined
): boolean {
  return isFreshClaudeLaunch(
    { ...ctx.args, preAdoptedStablePane: Boolean(ctx.preAdoptedStablePane) },
    pinnedAccountId
  )
}

export async function prepareRuntimeSpawnClaudeAuth(
  ctx: RuntimePtySpawnState,
  pinnedAccountId: string | undefined
): Promise<RuntimePtySpawnState['claudeAuth']> {
  if (!ctx.isClaudeLaunch) {
    if (pinnedAccountId) {
      throw new Error('This Orca runtime cannot prepare Claude accounts for --account launches.')
    }
    return null
  }
  return preparePinnableClaudeAuth(
    ctx.deps.prepareClaudeAuth,
    ctx.codexSelectionTarget,
    pinnedAccountId
  )
}

export function markRuntimeClaudePtySpawned(
  ptyId: string,
  claudeAuth: RuntimePtySpawnState['claudeAuth']
): void {
  markClaudePtySpawnedForAuth(ptyId, claudeAuth)
}
