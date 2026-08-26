import { getAppEnvironment } from '../../../../shared/app-environment'
import type { PtySpawnResult } from '../../../providers/types'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { getAppPtyId, getProvider, getRelayPtyId } from '../provider/registry'
import { buildPtyHostEnv } from '../host-env/assembly'
import {
  getCompatibleSelectedCodexHomePath,
  getCodexSelectionTargetForPty,
  resolveCodexHomeAfterManagedAuthReadiness,
  shouldSkipCodexHomeEnvForWindowsShell,
  shouldStripInheritedOrcaCodexHome,
  isCodexStatusHooksEnabled,
  codexHomePathsEqual
} from '../host-env/codex-home'
import { promoteAgentTeamsShimPath } from '../host-env/path'
import {
  isClaudeLaunchCommand,
  recoverFreshSpawnProviderRouting,
  routesFreshSpawnsToLocalProvider
} from '../host-env/fresh-spawn-routing'
import { stripRemotePaneEnvWhenHooksDisabled } from '../provider/liveness'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isClaudeAuthSwitchInProgress } from '../../../claude-accounts/live-pty-gate'
import { hasClaudeAuthEnvConflict } from '../../../claude-accounts/environment'
import {
  isSafePtySessionId,
  mintPtySessionId,
  ptySessionIdForAgentCreateOperation
} from '../../../daemon/pty-session-id'
import { resolveWslSessionContext } from '../../../daemon/wsl-session-context'
import { isAgentStatusHooksEnabled } from '../../../agent-hooks/managed-agent-hook-controls'
import { resolveLocalWindowsTerminalRuntimeOptions } from '../../../../shared/local-windows-terminal-runtime'
import { resolveLocalProjectRuntimeForWorktreeId } from '../../../local-project-runtime-resolution'
import { resolvePathEnvKey } from '../../../pty/windows-environment-path'
import { stampWslOrchestrationCompatibilityHost } from '../../../pty/wsl-orca-env'
import { ensureCodexStateDbBackfillRecoveryStarted } from '../../../codex/codex-state-db-backfill-recovery'
import { clearProviderPtyState } from '../provider/state-cleanup'
import type { RuntimePtySpawnState } from './spawn-state'

export async function prepareRuntimePtySpawn(
  ctx: RuntimePtySpawnState
): Promise<PtySpawnResult | null> {
  const args = ctx.args
  if (!ctx.preAdoptedStablePane) {
    const pathUsable = ctx.deps.assertFolderWorkspacePtyPathUsable(args.worktreeId)
    if (pathUsable) {
      await pathUsable
    }
  }
  ctx.cwd = ctx.deps.resolvePtySpawnStartupCwd(args.worktreeId, args.cwd)
  ctx.provider = getProvider(args.connectionId)
  const freshSpawnRecovery = ctx.preAdoptedStablePane
    ? undefined
    : recoverFreshSpawnProviderRouting(
        ctx.provider,
        args.connectionId,
        args.sessionId,
        args.isNewSession
      )
  if (freshSpawnRecovery) {
    await freshSpawnRecovery
  }
  ctx.isClaudeLaunch =
    !ctx.preAdoptedStablePane && !args.connectionId && isClaudeLaunchCommand(args.command)
  if (ctx.isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
    throw new Error('A Claude account switch is in progress. Try again after it finishes.')
  }
  // Why: runtime-created terminals carry no renderer-computed projectRuntime; resolve from worktreeId to honor the project's Windows runtime.
  ctx.terminalRuntimeOptions =
    process.platform === 'win32' && !args.connectionId
      ? resolveLocalWindowsTerminalRuntimeOptions({
          requestedShellOverride: undefined,
          settings: ctx.deps.getSettings?.(),
          projectRuntime: resolveLocalProjectRuntimeForWorktreeId(ctx.deps.store, args.worktreeId),
          fallbackHostShell: process.env.COMSPEC || 'powershell.exe'
        })
      : { shellOverride: undefined, terminalWindowsWslDistro: null }
  ctx.daemonShellOverride = ctx.terminalRuntimeOptions.shellOverride
  ctx.isDaemonHostSpawn =
    !args.connectionId &&
    !(ctx.provider instanceof LocalPtyProvider) &&
    !routesFreshSpawnsToLocalProvider(ctx.provider)
  ctx.callerRequestedSessionId = args.sessionId?.trim()
  ctx.requestedSessionId =
    ctx.callerRequestedSessionId ??
    (ctx.isDaemonHostSpawn && args.agentSessionCreateOperationId
      ? ptySessionIdForAgentCreateOperation(args.worktreeId, args.agentSessionCreateOperationId)
      : undefined)
  ctx.sessionId =
    ctx.requestedSessionId ??
    (ctx.isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
  ctx.effectiveSessionRelayId =
    ctx.sessionId !== undefined ? getRelayPtyId(args.connectionId, ctx.sessionId) : undefined
  ctx.effectiveSessionAppId =
    ctx.sessionId !== undefined ? getAppPtyId(args.connectionId, ctx.sessionId) : undefined
  ctx.isNewDaemonSession =
    !ctx.preAdoptedStablePane &&
    ctx.isDaemonHostSpawn &&
    (ctx.callerRequestedSessionId === undefined || args.isNewSession === true)
  ctx.expectedWslDistro = !args.connectionId
    ? (resolveWslSessionContext({
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        shellOverride: ctx.terminalRuntimeOptions.shellOverride,
        terminalWindowsWslDistro: ctx.terminalRuntimeOptions.terminalWindowsWslDistro
      })?.distro ?? null)
    : null
  ctx.codexSelectionTarget = getCodexSelectionTargetForPty(
    ctx.daemonShellOverride,
    ctx.cwd,
    ctx.expectedWslDistro
  )
  const codexResumePreparation = ctx.preAdoptedStablePane
    ? null
    : ctx.deps.prepareCodexResumeHome({
        connectionId: args.connectionId,
        launchAgent: args.launchAgent,
        providerSession: args.resumeProviderSession,
        target: ctx.codexSelectionTarget,
        launchEnv: args.env,
        workspacePath: ctx.cwd
      })
  const codexResumeLaunch = codexResumePreparation
    ? await ctx.deps.resolveCodexResumeLaunch(args.command, codexResumePreparation)
    : ctx.deps.noCodexResumeLaunch(ctx.preAdoptedStablePane ? undefined : args.command)
  const codexResumeHome = codexResumeLaunch.codexResumeHome
  // Why: the drop still applies here, but this controller's result has no field for
  // notifyResumeUnavailable — runtime/relay panes start fresh without the notice.
  ctx.launchCommand = codexResumeLaunch.command
  ctx.claudeAuth =
    ctx.isClaudeLaunch && ctx.deps.prepareClaudeAuth
      ? await ctx.deps.prepareClaudeAuth(ctx.codexSelectionTarget)
      : null
  if (ctx.isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
    throw new Error('A Claude account switch is in progress. Try again after it finishes.')
  }
  if (ctx.claudeAuth?.stripAuthEnv && hasClaudeAuthEnvConflict(args.env)) {
    throw new Error(
      'This Claude launch defines explicit Anthropic auth environment variables. Remove those overrides before using a managed Claude account.'
    )
  }

  ctx.shouldPersistHostSessionBinding = args.persistHostSessionBinding === true
  if (ctx.shouldPersistHostSessionBinding) {
    if (
      !ctx.deps.store ||
      typeof args.worktreeId !== 'string' ||
      typeof args.tabId !== 'string' ||
      !isValidTerminalTabId(args.tabId) ||
      typeof args.leafId !== 'string' ||
      !isTerminalLeafId(args.leafId)
    ) {
      throw new Error('Cannot persist runtime PTY binding without worktreeId, tabId, and leafId')
    }
    ctx.hostSessionBinding = {
      store: ctx.deps.store,
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      leafId: args.leafId,
      ...(args.expectedSourceBinding ? { expectedSourceBinding: args.expectedSourceBinding } : {})
    }
  }
  const sshScopedEnv = stripRemotePaneEnvWhenHooksDisabled(args.connectionId, args.env)
  ctx.env = ctx.claudeAuth ? { ...sshScopedEnv, ...ctx.claudeAuth.envPatch } : sshScopedEnv
  ctx.requestedAgentTeamsPath = ctx.env?.ORCA_AGENT_TEAMS_TEAM_ID
    ? ctx.env[resolvePathEnvKey(ctx.env, process.platform)]
    : undefined
  ctx.env = ctx.deps.stripSequencedStartupResumeArgv(ctx.env, codexResumeLaunch)
  if (args.preAllocatedHandle) {
    ctx.env = { ...ctx.env, ORCA_TERMINAL_HANDLE: args.preAllocatedHandle }
  }
  const selectLaunchCodexHome = async (): Promise<string | null> =>
    (await ctx.deps.getSelectedCodexHomePath?.(ctx.codexSelectionTarget, ctx.env, {
      workspacePath: ctx.cwd,
      launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined
    })) ?? null
  ctx.selectedCodexHomePath =
    !ctx.preAdoptedStablePane && !args.connectionId
      ? getCompatibleSelectedCodexHomePath(
          ctx.codexSelectionTarget,
          codexResumeHome
            ? await ctx.deps.reconcileSharedRuntimeResumeHome(codexResumeHome, async () =>
                getCompatibleSelectedCodexHomePath(
                  ctx.codexSelectionTarget,
                  await selectLaunchCodexHome()
                )
              )
            : await selectLaunchCodexHome()
        )
      : null
  if (
    !ctx.preAdoptedStablePane &&
    args.launchAgent === 'codex' &&
    ctx.callerRequestedSessionId === undefined
  ) {
    const resolution = resolveCodexHomeAfterManagedAuthReadiness({
      selectedCodexHomePath: ctx.selectedCodexHomePath,
      getSettings: () => ctx.deps.getSettings?.(),
      requiredCodexHomePath: codexResumeHome?.codexHomePath,
      target: ctx.codexSelectionTarget,
      resolveCurrent: async () =>
        getCompatibleSelectedCodexHomePath(
          ctx.codexSelectionTarget,
          (await ctx.deps.getSelectedCodexHomePath?.(ctx.codexSelectionTarget, ctx.env, {
            workspacePath: ctx.cwd,
            launchAgent: 'codex'
          })) ?? null
        ),
      resolveAfterUnavailable: async (unavailableManagedHomePath) =>
        getCompatibleSelectedCodexHomePath(
          ctx.codexSelectionTarget,
          (await ctx.deps.getSelectedCodexHomePath?.(ctx.codexSelectionTarget, ctx.env, {
            workspacePath: ctx.cwd,
            launchAgent: 'codex',
            unavailableManagedHomePath
          })) ?? null
        )
    })
    ctx.selectedCodexHomePath = resolution instanceof Promise ? await resolution : resolution
  }
  if (args.launchAgent === 'codex' && ctx.selectedCodexHomePath) {
    await ensureCodexStateDbBackfillRecoveryStarted(ctx.selectedCodexHomePath)
  }
  ctx.codexResumeHomeSelected = Boolean(
    codexResumeHome && codexHomePathsEqual(ctx.selectedCodexHomePath, codexResumeHome.codexHomePath)
  )
  ctx.skipCodexHomeEnv =
    ctx.isDaemonHostSpawn &&
    shouldSkipCodexHomeEnvForWindowsShell(ctx.daemonShellOverride, ctx.cwd) &&
    !ctx.selectedCodexHomePath
  const ptySettings = ctx.isDaemonHostSpawn ? ctx.deps.getSettings?.() : undefined
  ctx.stripInheritedOrcaCodexHome =
    ctx.isDaemonHostSpawn &&
    shouldStripInheritedOrcaCodexHome({
      target: ctx.codexSelectionTarget,
      selectedCodexHomePath: ctx.selectedCodexHomePath,
      skipCodexHomeEnv: ctx.skipCodexHomeEnv,
      settings: ptySettings
    })
  if (ctx.isDaemonHostSpawn && ctx.sessionId && !ctx.preAdoptedStablePane) {
    if (!isSafePtySessionId(ctx.sessionId, getAppEnvironment().getPath('userData'))) {
      throw new Error('Invalid PTY session id')
    }
    try {
      ctx.env = buildPtyHostEnv(ctx.sessionId, ctx.env ?? {}, {
        isPackaged: getAppEnvironment().isPackaged(),
        resourcesPath: process.resourcesPath,
        userDataPath: getAppEnvironment().getPath('userData'),
        selectedCodexHomePath: ctx.selectedCodexHomePath,
        skipCodexHomeEnv: ctx.skipCodexHomeEnv,
        stripInheritedOrcaCodexHome: ctx.stripInheritedOrcaCodexHome,
        launchCommand: ctx.launchCommand,
        launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined,
        isWsl: shouldSkipCodexHomeEnvForWindowsShell(ctx.daemonShellOverride, ctx.cwd),
        wslDistro: ctx.codexSelectionTarget.runtime === 'wsl' ? ctx.expectedWslDistro : null,
        agentStatusHooksEnabled: isAgentStatusHooksEnabled(ptySettings),
        codexStatusHooksEnabled: isCodexStatusHooksEnabled(ptySettings),
        networkProxySettings: ptySettings,
        deferGitConfigGuardToDaemon:
          ctx.provider.supportsGitCredentialGuardHost?.(ctx.sessionId) === true
      })
      stampWslOrchestrationCompatibilityHost(
        ctx.env,
        ctx.deps.runtime?.getOrchestrationCompatibilityHostId?.(),
        ctx.codexSelectionTarget.runtime === 'wsl' ? ctx.expectedWslDistro : null
      )
      promoteAgentTeamsShimPath(ctx.env, ctx.requestedAgentTeamsPath)
    } catch (error) {
      // Why: host-env setup can materialize agent hooks/extensions before failing.
      if (ctx.requestedSessionId === undefined) {
        clearProviderPtyState(ctx.sessionId)
      }
      throw error
    }
  }

  return null
}
