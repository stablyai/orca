import { withClaudeProfileTerminalEnv } from '../../../claude-accounts/claude-profile-installed-router'
import { mintPtySessionId } from '../../../daemon/pty-session-id'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import {
  recoverFreshSpawnProviderRouting,
  routesFreshSpawnsToLocalProvider
} from '../host-env/fresh-spawn-routing'
import { resolveProjectClaudeAccount } from '../../../claude-accounts/project-claude-account-resolution'
import { isFreshClaudeLaunch, preparePinnableClaudeAuth } from '../claude-pinned-spawn'
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
      localPtySpawnCwd(args),
      args.wslPassiveRestore === true,
      args.connectionId
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
      localPtySpawnCwd(args),
      args.wslPassiveRestore === true,
      args.connectionId
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
    resolveStartupCwd: (id, cwd, fallback) =>
      ctx.deps.resolvePtySpawnStartupCwd(id, cwd, fallback, args.connectionId),
    ...(args.wslPassiveRestore === true
      ? {
          wslStartHold: {
            wslPassiveRestore: true,
            sessionId: ctx.effectiveSessionId,
            isNewSession: ctx.ownsNewIncarnation,
            attachOnly: args.attachOnlyView === true
          }
        }
      : {})
  })
  ctx.cwd = target.cwd
  ctx.prevalidatedCwd = target.prevalidatedCwd
  ctx.requestedCwd = target.requestedCwd
  ctx.correctStartupCwd = target.correctStartupCwd
  ctx.startupCwdFallback = target.startupCwdFallback
  ctx.terminalRuntimeOptions = target.terminalRuntimeOptions
  ctx.expectedWslDistro = target.expectedWslDistro
  ctx.wslHoldReadAnchor = target.wslHoldReadAnchor
  ctx.codexSelectionTarget = target.codexSelectionTarget
  ctx.spawnTiming.mark('preflight')
  const pinnedClaudeAccountId =
    ctx.preAdoptedStablePane || args.connectionId
      ? undefined
      : resolveProjectClaudeAccount({
          // Why optional: as in the push-target hook, a partial Store must not fail every spawn.
          getRepo: (repoId) => ctx.deps.store?.getRepo?.(repoId),
          worktreeId: args.worktreeId,
          // Why unchecked: launchConfig is untrusted IPC JSON; the resolver validates the id itself.
          launchConfigAccountId: args.launchConfig?.claudeAccountId,
          target: ctx.codexSelectionTarget
        })
  ctx.isClaudeLaunch = isFreshClaudeLaunch(
    { ...args, preAdoptedStablePane: Boolean(ctx.preAdoptedStablePane) },
    pinnedClaudeAccountId
  )
  ctx.claudeAuth = ctx.isClaudeLaunch
    ? await preparePinnableClaudeAuth(
        ctx.deps.prepareClaudeAuth,
        ctx.codexSelectionTarget,
        pinnedClaudeAccountId
      )
    : null
  // Why not pinned: the routed pointer would send a pinned pane's `claude` back to the selected account.
  if (!ctx.claudeAuth?.pinnedAccountId) {
    args.env = withClaudeProfileTerminalEnv(args.env, ctx.codexSelectionTarget)
  }
  ctx.spawnTiming.mark('auth')
}
