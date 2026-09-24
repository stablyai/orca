import { isClaudeLaunchCommand } from '../host-env/fresh-spawn-routing'
import { markClaudePtySpawned } from '../../../claude-accounts/live-pty-gate'
import { markPinnedClaudePtySpawned } from '../../../claude-accounts/claude-pinned-pty-registry'
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
  const { args } = ctx
  if (ctx.preAdoptedStablePane || args.connectionId) {
    return false
  }
  // Why: a wait-for-setup launch types a setup gate, not `claude`; for a pinned launch the agent
  // id is the proof, and its credentials must still be prepared.
  return (
    isClaudeLaunchCommand(args.command) ||
    (Boolean(pinnedAccountId) && args.launchAgent === 'claude')
  )
}

export async function prepareRuntimeSpawnClaudeAuth(
  ctx: RuntimePtySpawnState,
  pinnedAccountId: string | undefined
): Promise<RuntimePtySpawnState['claudeAuth']> {
  if (!ctx.isClaudeLaunch || !ctx.deps.prepareClaudeAuth) {
    if (pinnedAccountId) {
      throw new Error('This Orca runtime cannot prepare Claude accounts for --account launches.')
    }
    return null
  }
  if (!pinnedAccountId) {
    return ctx.deps.prepareClaudeAuth(ctx.codexSelectionTarget)
  }
  const claudeAuth = await ctx.deps.prepareClaudeAuth(ctx.codexSelectionTarget, {
    accountId: pinnedAccountId
  })
  // Why: the active path (`managed:<id>`) also honours the request; any other account must not run.
  if (
    claudeAuth.provenance !== `managed:${pinnedAccountId}:pinned` &&
    claudeAuth.provenance !== `managed:${pinnedAccountId}`
  ) {
    throw new Error(
      'Orca could not prepare the requested Claude account for this launch. Check `orca account list` and retry.'
    )
  }
  return claudeAuth
}

export function markRuntimeClaudePtySpawned(
  ptyId: string,
  claudeAuth: RuntimePtySpawnState['claudeAuth']
): void {
  if (claudeAuth?.pinnedAccountId) {
    // Why: a pinned PTY guards its own account, not the active one the global gate defers.
    markPinnedClaudePtySpawned(ptyId, claudeAuth.pinnedAccountId)
    return
  }
  markClaudePtySpawned(ptyId)
}
