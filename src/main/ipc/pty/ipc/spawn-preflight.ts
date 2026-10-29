import { withClaudeProfileTerminalEnv } from '../../../claude-accounts/claude-profile-installed-router'
import { mintPtySessionId } from '../../../daemon/pty-session-id'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import {
  isClaudeLaunchCommand,
  recoverFreshSpawnProviderRouting,
  routesFreshSpawnsToLocalProvider
} from '../host-env/fresh-spawn-routing'
import { getProvider } from '../provider/registry'
import { resolvePtySpawnStartupTarget } from '../spawn-startup-target'
import type { PtyIpcSpawnState } from './spawn-state'
import { localPtySpawnCwd } from '../host-env/spawn-cwd'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'

export async function preparePtyIpcSpawnPreflight(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  // Establish local daemon identity before yielding so early output can be hidden; SSH execution is rejected here.
  ctx.provider = getProvider(getConnectionExecutionHostId(args.connectionId))
  ctx.isDaemonHostSpawn =
    !(ctx.provider instanceof LocalPtyProvider) && !routesFreshSpawnsToLocalProvider(ctx.provider)
  ctx.ownsNewIncarnation = args.sessionId === undefined && ctx.isDaemonHostSpawn
  ctx.effectiveSessionId =
    args.sessionId ?? (ctx.isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
  ctx.effectiveSessionAppId = ctx.effectiveSessionId
  ctx.initiallyHidden = args.initiallyHidden === true
  ctx.preSpawnHiddenMarkId =
    ctx.initiallyHidden && ctx.isDaemonHostSpawn && ctx.effectiveSessionAppId !== undefined
      ? ctx.effectiveSessionAppId
      : null
  if (ctx.preSpawnHiddenMarkId !== null) {
    ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, true)
  }
  if (!ctx.earlyStablePaneOwner) {
    const admission = ctx.deps.assertWorkspaceAcceptsNewPty(
      args.worktreeId,
      args.sessionId,
      localPtySpawnCwd(args)
    )
    if (admission) {
      await admission
    }
  }
  ctx.spawnTiming.mark('stable_adoption_setup')
  ctx.preAdoptedStablePane = null
  ctx.spawnTiming.mark('stable_adoption')
  if (ctx.earlyStablePaneOwner && !ctx.preAdoptedStablePane) {
    const admission = ctx.deps.assertWorkspaceAcceptsNewPty(
      args.worktreeId,
      args.sessionId,
      localPtySpawnCwd(args)
    )
    if (admission) {
      await admission
    }
  }
  const freshSpawnRecovery = ctx.preAdoptedStablePane
    ? undefined
    : recoverFreshSpawnProviderRouting(ctx.provider, args.sessionId)
  if (freshSpawnRecovery) {
    await freshSpawnRecovery
    const previousHiddenMarkId = ctx.preSpawnHiddenMarkId
    ctx.isDaemonHostSpawn =
      !(ctx.provider instanceof LocalPtyProvider) && !routesFreshSpawnsToLocalProvider(ctx.provider)
    ctx.ownsNewIncarnation = args.sessionId === undefined && ctx.isDaemonHostSpawn
    ctx.effectiveSessionId =
      args.sessionId ?? (ctx.isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
    ctx.effectiveSessionAppId = ctx.effectiveSessionId
    ctx.preSpawnHiddenMarkId =
      ctx.initiallyHidden && ctx.isDaemonHostSpawn && ctx.effectiveSessionAppId !== undefined
        ? ctx.effectiveSessionAppId
        : null
    if (previousHiddenMarkId !== ctx.preSpawnHiddenMarkId) {
      if (previousHiddenMarkId !== null) {
        ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(previousHiddenMarkId, false)
      }
      if (ctx.preSpawnHiddenMarkId !== null) {
        ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, true)
      }
    }
  }
  ctx.isClaudeLaunch = !ctx.preAdoptedStablePane && isClaudeLaunchCommand(args.command)
  // Stable caller IDs preserve reconnect state; failure cleanup must remove only IDs minted by this request.
  const target = await resolvePtySpawnStartupTarget({
    worktreeId: args.worktreeId,
    cwd: args.cwd,
    sessionId: ctx.effectiveSessionId,
    shellOverride: args.shellOverride,
    plannedPty: ctx.paneAgentLaunch?.launchRuntime?.pty,
    projectRuntimeSource: { kind: 'sent', projectRuntime: args.projectRuntime },
    preAdopted: ctx.preAdoptedStablePane !== null,
    getSettings: ctx.deps.getSettings,
    resolveStartupCwd: ctx.deps.resolvePtySpawnStartupCwd
  })
  ctx.cwd = target.cwd
  ctx.prevalidatedCwd = target.prevalidatedCwd
  ctx.requestedCwd = target.requestedCwd
  ctx.correctStartupCwd = target.correctStartupCwd
  ctx.startupCwdFallback = target.startupCwdFallback
  ctx.terminalRuntimeOptions = target.terminalRuntimeOptions
  ctx.expectedWslDistro = target.expectedWslDistro
  ctx.codexSelectionTarget = target.codexSelectionTarget
  ctx.spawnTiming.mark('preflight')
  args.env = withClaudeProfileTerminalEnv(args.env, ctx.codexSelectionTarget)
  ctx.claudeAuth =
    ctx.isClaudeLaunch && ctx.deps.prepareClaudeAuth
      ? await ctx.deps.prepareClaudeAuth(ctx.codexSelectionTarget)
      : null
  ctx.spawnTiming.mark('auth')
}
