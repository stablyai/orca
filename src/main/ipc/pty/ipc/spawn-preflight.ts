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
import { keepAbsentBindingForSwap } from './spawn-absent-binding-swap'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'

export async function preparePtyIpcSpawnPreflight(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  // Establish daemon identity before the first await so hidden delivery is gated before byte zero.
  // Only this machine spawns here: an `ssh:` connection throws, so every line below is local.
  ctx.provider = getProvider(getConnectionExecutionHostId(args.connectionId))
  ctx.isDaemonHostSpawn =
    !(ctx.provider instanceof LocalPtyProvider) && !routesFreshSpawnsToLocalProvider(ctx.provider)
  ctx.isMintedSessionId = args.sessionId === undefined && ctx.isDaemonHostSpawn
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
    const admission = ctx.deps.assertWorkspaceAcceptsNewPty(args.worktreeId, args.sessionId)
    if (admission) {
      await admission
    }
  }
  ctx.spawnTiming.mark('stable_adoption_setup')
  ctx.preAdoptedStablePane =
    ctx.earlyStablePaneOwner && ctx.earlyWorktreeId
      ? await ctx.deps.adoptStablePane({
          cols: args.cols,
          rows: args.rows,
          cwd: ctx.cwd,
          connectionId: args.connectionId,
          worktreeId: ctx.earlyWorktreeId,
          tabId: ctx.earlyStablePaneOwner.tabId,
          leafId: ctx.earlyStablePaneOwner.leafId,
          ownsPaneSpawnReservation: true,
          keepAbsentBinding: keepAbsentBindingForSwap(ctx)
        })
      : null
  ctx.spawnTiming.mark('stable_adoption')
  if (ctx.earlyStablePaneOwner && !ctx.preAdoptedStablePane) {
    const admission = ctx.deps.assertWorkspaceAcceptsNewPty(args.worktreeId, args.sessionId)
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
    ctx.isMintedSessionId = args.sessionId === undefined && ctx.isDaemonHostSpawn
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
  // Why: daemon host-env setup needs a stable id BEFORE provider.spawn so buildPtyHostEnv hooks/Pi cleanup can run; daemon still honors opts.sessionId ?? mint().
  // Note: sessionId is STABLE across daemon restarts by design — do NOT simplify to a fresh UUID per spawn; that orphans reconnectable state.
  // Why: only clear ids minted in THIS request on failure — a caller-supplied args.sessionId may name an existing PTY we must not clobber.
  const target = await resolvePtySpawnStartupTarget({
    worktreeId: args.worktreeId,
    cwd: args.cwd,
    sessionId: ctx.effectiveSessionId,
    shellOverride: args.shellOverride,
    plannedPty: ctx.paneAgentLaunch?.launchRuntime?.pty,
    projectRuntimeSource: { kind: 'sent', projectRuntime: args.projectRuntime },
    // Why: reattach needs exact cwd, and successful stable-pane adoption needs no launch preflight.
    missingCwdFallback:
      !ctx.preAdoptedStablePane && !args.sessionId && args.cwdFallback === 'worktree'
        ? { directoryExists: ctx.deps.localStartupCwdDirectoryExists }
        : undefined,
    getSettings: ctx.deps.getSettings,
    resolveStartupCwd: ctx.deps.resolvePtySpawnStartupCwd
  })
  ctx.cwd = target.cwd
  ctx.prevalidatedCwd = target.prevalidatedCwd
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
