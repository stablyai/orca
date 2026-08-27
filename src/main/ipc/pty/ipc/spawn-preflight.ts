import {
  isWslShellName,
  resolveLocalWindowsTerminalRuntimeOptions
} from '../../../../shared/local-windows-terminal-runtime'
import { isWslUncPath, toWindowsWslPath } from '../../../../shared/wsl-paths'
import { isClaudeAuthSwitchInProgress } from '../../../claude-accounts/live-pty-gate'
import { mintPtySessionId } from '../../../daemon/pty-session-id'
import { resolveWslSessionContext } from '../../../daemon/wsl-session-context'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { normalizeWindowsTerminalCwd } from '../../../providers/windows-shell-args'
import { wslUncDirectoryExistsAsync } from '../../../wsl'
import { getCodexSelectionTargetForPty } from '../host-env/codex-home'
import {
  isClaudeLaunchCommand,
  recoverFreshSpawnProviderRouting,
  routesFreshSpawnsToLocalProvider
} from '../host-env/fresh-spawn-routing'
import { getAppPtyId, getProvider, getRelayPtyId } from '../provider/registry'
import type { PtyIpcSpawnState } from './spawn-state'

export async function preparePtyIpcSpawnPreflight(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  // Establish daemon identity before the first await so hidden delivery is gated before byte zero.
  ctx.provider = getProvider(args.connectionId)
  ctx.isDaemonHostSpawn =
    !args.connectionId &&
    !(ctx.provider instanceof LocalPtyProvider) &&
    !routesFreshSpawnsToLocalProvider(ctx.provider)
  ctx.isMintedSessionId = args.sessionId === undefined && ctx.isDaemonHostSpawn
  ctx.effectiveSessionId =
    args.sessionId ?? (ctx.isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
  ctx.effectiveSessionAppId =
    ctx.effectiveSessionId !== undefined
      ? getAppPtyId(args.connectionId, ctx.effectiveSessionId)
      : undefined
  ctx.effectiveSessionRelayId =
    ctx.effectiveSessionId !== undefined
      ? getRelayPtyId(args.connectionId, ctx.effectiveSessionId)
      : undefined
  ctx.initiallyHidden = args.initiallyHidden === true
  ctx.preSpawnHiddenMarkId =
    ctx.initiallyHidden && ctx.isDaemonHostSpawn && ctx.effectiveSessionAppId !== undefined
      ? ctx.effectiveSessionAppId
      : null
  if (ctx.preSpawnHiddenMarkId !== null) {
    ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, true)
  }
  if (!ctx.earlyStablePaneOwner) {
    const pathUsable = ctx.deps.assertFolderWorkspacePtyPathUsable(args.worktreeId)
    if (pathUsable) {
      await pathUsable
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
          ownsPaneSpawnReservation: true
        })
      : null
  ctx.spawnTiming.mark('stable_adoption')
  if (ctx.earlyStablePaneOwner && !ctx.preAdoptedStablePane) {
    const pathUsable = ctx.deps.assertFolderWorkspacePtyPathUsable(args.worktreeId)
    if (pathUsable) {
      await pathUsable
    }
  }
  if (!ctx.preAdoptedStablePane) {
    // Why: reattach needs exact cwd, SSH cannot probe locally, and successful stable-pane adoption needs no launch preflight.
    const requestedMissingCwdFallback =
      !args.connectionId && !args.sessionId && args.cwdFallback === 'worktree'
    const isPosixStartupCwd = args.cwd?.startsWith('/') === true
    const startupWorkspaceCwd =
      requestedMissingCwdFallback && isPosixStartupCwd
        ? ctx.deps.resolvePtySpawnStartupCwd(args.worktreeId, '.')
        : undefined
    const initiallyResolvedStartupCwd =
      requestedMissingCwdFallback && isPosixStartupCwd ? ctx.cwd : undefined
    const startupTerminalRuntimeOptions =
      requestedMissingCwdFallback && process.platform === 'win32'
        ? resolveLocalWindowsTerminalRuntimeOptions({
            requestedShellOverride: args.shellOverride,
            settings: ctx.deps.getSettings?.(),
            projectRuntime: args.projectRuntime,
            fallbackHostShell: process.env.COMSPEC || 'powershell.exe'
          })
        : undefined
    const wslRuntimeOwnsStartupCwd =
      requestedMissingCwdFallback &&
      isPosixStartupCwd &&
      (isWslShellName(startupTerminalRuntimeOptions?.shellOverride) ||
        isWslUncPath(startupWorkspaceCwd ?? ''))
    const startupWslContext = wslRuntimeOwnsStartupCwd
      ? resolveWslSessionContext({
          cwd: startupWorkspaceCwd,
          shellOverride: startupTerminalRuntimeOptions?.shellOverride,
          terminalWindowsWslDistro: startupTerminalRuntimeOptions?.terminalWindowsWslDistro
        })
      : undefined
    let wslStartupCwdExists: boolean | null = null
    let wslWorkspaceCwdExists: boolean | null = null
    if (startupWslContext && initiallyResolvedStartupCwd) {
      const validationCwd = toWindowsWslPath(initiallyResolvedStartupCwd, startupWslContext.distro)
      wslStartupCwdExists = isWslUncPath(validationCwd)
        ? await wslUncDirectoryExistsAsync(validationCwd)
        : ctx.deps.localStartupCwdDirectoryExists(validationCwd)
      if (wslStartupCwdExists === true) {
        ctx.prevalidatedCwd = validationCwd
      }
      if (wslStartupCwdExists === false && startupWorkspaceCwd) {
        wslWorkspaceCwdExists = isWslUncPath(startupWorkspaceCwd)
          ? await wslUncDirectoryExistsAsync(startupWorkspaceCwd)
          : ctx.deps.localStartupCwdDirectoryExists(startupWorkspaceCwd)
        if (wslWorkspaceCwdExists === true) {
          ctx.prevalidatedCwd = startupWorkspaceCwd
        }
      }
    }
    const allowMissingCwdFallback =
      requestedMissingCwdFallback &&
      (!wslRuntimeOwnsStartupCwd ||
        (wslStartupCwdExists === false && wslWorkspaceCwdExists === true))
    let didFallbackToWorkspaceRootCwd = false
    ctx.cwd = ctx.deps.resolvePtySpawnStartupCwd(
      args.worktreeId,
      args.cwd,
      allowMissingCwdFallback
        ? {
            directoryExists: (path) =>
              startupWslContext &&
              wslStartupCwdExists === false &&
              path === initiallyResolvedStartupCwd
                ? false
                : startupWslContext && path === startupWorkspaceCwd
                  ? wslWorkspaceCwdExists === true
                  : ctx.deps.localStartupCwdDirectoryExists(
                      process.platform === 'win32' ? normalizeWindowsTerminalCwd(path) : path
                    ),
            onFallbackToWorkspaceRoot: () => {
              didFallbackToWorkspaceRootCwd = true
            }
          }
        : undefined
    )
    if (didFallbackToWorkspaceRootCwd && wslWorkspaceCwdExists === true && ctx.cwd) {
      ctx.prevalidatedCwd = ctx.cwd
    }
    ctx.startupCwdFallback =
      didFallbackToWorkspaceRootCwd && ctx.cwd ? { kind: 'worktree', cwd: ctx.cwd } : undefined
  }
  ctx.spawnTiming.mark('preflight')
  const freshSpawnRecovery = ctx.preAdoptedStablePane
    ? undefined
    : recoverFreshSpawnProviderRouting(ctx.provider, args.connectionId, args.sessionId)
  if (freshSpawnRecovery) {
    await freshSpawnRecovery
    const previousHiddenMarkId = ctx.preSpawnHiddenMarkId
    ctx.isDaemonHostSpawn =
      !args.connectionId &&
      !(ctx.provider instanceof LocalPtyProvider) &&
      !routesFreshSpawnsToLocalProvider(ctx.provider)
    ctx.isMintedSessionId = args.sessionId === undefined && ctx.isDaemonHostSpawn
    ctx.effectiveSessionId =
      args.sessionId ?? (ctx.isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
    ctx.effectiveSessionAppId =
      ctx.effectiveSessionId !== undefined
        ? getAppPtyId(args.connectionId, ctx.effectiveSessionId)
        : undefined
    ctx.effectiveSessionRelayId =
      ctx.effectiveSessionId !== undefined
        ? getRelayPtyId(args.connectionId, ctx.effectiveSessionId)
        : undefined
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
  ctx.isClaudeLaunch =
    !ctx.preAdoptedStablePane && !args.connectionId && isClaudeLaunchCommand(args.command)
  if (ctx.isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
    throw new Error('A Claude account switch is in progress. Try again after it finishes.')
  }
  ctx.terminalRuntimeOptions =
    process.platform === 'win32' && !args.connectionId
      ? resolveLocalWindowsTerminalRuntimeOptions({
          requestedShellOverride: args.shellOverride,
          settings: ctx.deps.getSettings?.(),
          projectRuntime: args.projectRuntime,
          fallbackHostShell: process.env.COMSPEC || 'powershell.exe'
        })
      : { shellOverride: args.shellOverride, terminalWindowsWslDistro: null }
  const initialShellOverride = ctx.terminalRuntimeOptions.shellOverride
  // Why: daemon host-env setup needs a stable id BEFORE provider.spawn so buildPtyHostEnv hooks/Pi cleanup can run; daemon still honors opts.sessionId ?? mint().
  // Note: sessionId is STABLE across daemon restarts by design — do NOT simplify to a fresh UUID per spawn; that orphans reconnectable state.
  // Why: only clear ids minted in THIS request on failure — a caller-supplied args.sessionId may name an existing PTY we must not clobber.
  ctx.expectedWslDistro = !args.connectionId
    ? (resolveWslSessionContext({
        cwd: ctx.cwd,
        sessionId: ctx.effectiveSessionId,
        shellOverride: ctx.terminalRuntimeOptions.shellOverride,
        terminalWindowsWslDistro: ctx.terminalRuntimeOptions.terminalWindowsWslDistro
      })?.distro ?? null)
    : null
  const initialSelectionTarget = getCodexSelectionTargetForPty(
    initialShellOverride,
    ctx.cwd,
    ctx.expectedWslDistro
  )
  ctx.claudeAuth =
    ctx.isClaudeLaunch && ctx.deps.prepareClaudeAuth
      ? await ctx.deps.prepareClaudeAuth(initialSelectionTarget)
      : null
  ctx.spawnTiming.mark('auth')
}
