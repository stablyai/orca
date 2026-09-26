import { isClaudeLaunchCommand } from '../host-env/fresh-spawn-routing'
import {
  isFreshClaudeLaunch,
  preparePinnableClaudeAuth,
  markClaudePtySpawnedForAuth
} from '../claude-pinned-spawn'
import type { RuntimePtySpawnState } from './spawn-state'

/** The `--account` a fresh runtime spawn must run on, refused where a pinned launch cannot run. */
export function resolveRuntimeSpawnClaudeAccount(ctx: RuntimePtySpawnState): string | undefined {
  const accountId = ctx.preAdoptedStablePane ? undefined : ctx.args.claudeAccountId
  if (!accountId) {
    return undefined
  }
  if (ctx.args.connectionId) {
    throw new Error('Claude --account launches are not supported for SSH workspaces.')
  }
  if (!isClaudeLaunchCommand(ctx.args.command) && ctx.args.launchAgent !== 'claude') {
    throw new Error('--account applies only to Claude launches.')
  }
  return accountId
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
