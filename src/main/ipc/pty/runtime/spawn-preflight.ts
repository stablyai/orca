import { prepareRuntimeHostSpawnEnvironment } from './spawn-host-environment'
import { prepareWslDaemonSpawnRoute } from '../../../wsl/wsl-daemon-spawn-route'
import { toAppWslPtyId } from '../../../../shared/wsl-pty-id'
import type { PtySpawnResult } from '../../../providers/types'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { getAppPtyId, getProvider, getRelayPtyId } from '../provider/registry'
import {
  getCompatibleSelectedCodexHomePath,
  getCodexSelectionTargetForPty,
  resolveCodexHomeAfterManagedAuthReadiness,
  shouldSkipCodexHomeEnvForWindowsShell,
  shouldStripInheritedOrcaCodexHome,
  codexHomePathsEqual
} from '../host-env/codex-home'
import { isClaudeLaunchCommand } from '../host-env/fresh-spawn-routing'
import { stripRemotePaneEnvWhenHooksDisabled } from '../provider/liveness'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isClaudeAuthSwitchInProgress } from '../../../claude-accounts/live-pty-gate'
import {
  CLAUDE_AUTH_ENV_CONFLICT_MESSAGE,
  CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE,
  hasClaudeAuthEnvConflict
} from '../../../claude-accounts/environment'
import {
  mintPtySessionId,
  ptySessionIdForAgentCreateOperation
} from '../../../daemon/pty-session-id'
import { resolveWslSessionContext } from '../../../daemon/wsl-session-context'
import { resolveLocalWindowsTerminalRuntimeOptions } from '../../../../shared/local-windows-terminal-runtime'
import { resolveLocalProjectRuntimeForWorktreeId } from '../../../local-project-runtime-resolution'
import { resolvePathEnvKey } from '../../../pty/windows-environment-path'
import { ensureCodexStateDbBackfillRecoveryStarted } from '../../../codex/codex-state-db-backfill-recovery'
import type { RuntimePtySpawnState } from './spawn-state'

export async function prepareRuntimePtySpawn(
  ctx: RuntimePtySpawnState
): Promise<PtySpawnResult | null> {
  const args = ctx.args
  ctx.cwd = ctx.deps.resolvePtySpawnStartupCwd(args.worktreeId, args.cwd)
  ctx.provider = getProvider(args.connectionId)
  ctx.isClaudeLaunch =
    !ctx.preAdoptedStablePane && !args.connectionId && isClaudeLaunchCommand(args.command)
  if (ctx.isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
    throw new Error(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE)
  }
  // Why: runtime-created terminals carry no renderer-computed projectRuntime; resolve from worktreeId to honor the project's Windows runtime.
  // `args.shellOverride` is the per-request pick (`terminal create --shell`), read here the way
  // the renderer twin (ipc/spawn-preflight.ts) reads a tab's override. Without it a runtime create
  // could only ever get the host default shell, so a caller asking for cmd/PowerShell got the
  // default shell with the request typed into it. Still Windows-only: the override names a
  // Windows shell, and spawn-options applies it under the same platform gate.
  ctx.terminalRuntimeOptions =
    process.platform === 'win32' && !args.connectionId
      ? resolveLocalWindowsTerminalRuntimeOptions({
          requestedShellOverride: args.shellOverride,
          settings: ctx.deps.getSettings?.(),
          projectRuntime: resolveLocalProjectRuntimeForWorktreeId(ctx.deps.store, args.worktreeId),
          fallbackHostShell: process.env.COMSPEC || 'powershell.exe'
        })
      : {
          shellOverride:
            args.shellOverride ??
            (process.platform === 'win32'
              ? undefined
              : ctx.deps.getSettings?.()?.terminalDefaultShell || undefined),
          terminalWindowsWslDistro: null
        }
  ctx.daemonShellOverride = ctx.terminalRuntimeOptions.shellOverride
  ctx.isDaemonHostSpawn = !args.connectionId
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
  if (!ctx.preAdoptedStablePane) {
    ctx.wslGuest = await prepareWslDaemonSpawnRoute({
      sessions: ctx.deps.options?.wslDaemonSessions,
      connectionId: args.connectionId,
      sessionId: args.sessionId,
      isNewSession: args.isNewSession,
      distro: ctx.expectedWslDistro,
      signal: args.signal
    })
  }
  if (ctx.wslGuest) {
    ctx.provider = ctx.wslGuest.connection.provider
    ctx.expectedWslDistro = ctx.wslGuest.connection.owner.distro
    ctx.isDaemonHostSpawn = true
    ctx.isNewDaemonSession = ctx.wslGuest.fresh
    ctx.isClaudeLaunch &&= ctx.wslGuest.fresh || ctx.wslGuest.coldRestore === true
    ctx.sessionId ??= args.agentSessionCreateOperationId
      ? ptySessionIdForAgentCreateOperation(args.worktreeId, args.agentSessionCreateOperationId)
      : mintPtySessionId(args.worktreeId)
    ctx.effectiveSessionAppId = toAppWslPtyId(ctx.wslGuest.connection.owner, ctx.sessionId)
    ctx.effectiveSessionRelayId = ctx.sessionId
  } else {
    if (!ctx.preAdoptedStablePane) {
      const pathUsable = ctx.deps.assertFolderWorkspacePtyPathUsable(args.worktreeId)
      if (pathUsable) {
        await pathUsable
      }
    }
  }
  ctx.codexSelectionTarget = getCodexSelectionTargetForPty(
    ctx.daemonShellOverride,
    ctx.cwd,
    ctx.expectedWslDistro
  )
  const codexResumePreparation =
    ctx.preAdoptedStablePane || (ctx.wslGuest && !ctx.wslGuest.fresh && !ctx.wslGuest.coldRestore)
      ? null
      : ctx.deps.prepareCodexResumeHome({
          connectionId: args.connectionId,
          launchAgent: args.launchAgent,
          providerSession: args.resumeProviderSession,
          target: ctx.codexSelectionTarget,
          launchEnv: args.env,
          workspacePath: ctx.cwd,
          wslExecution: ctx.wslGuest?.execution
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
      ? await ctx.deps.prepareClaudeAuth(ctx.codexSelectionTarget, ctx.wslGuest?.execution)
      : null
  if (ctx.isClaudeLaunch && isClaudeAuthSwitchInProgress()) {
    throw new Error(CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE)
  }
  if (ctx.claudeAuth?.stripAuthEnv && hasClaudeAuthEnvConflict(args.env)) {
    throw new Error(CLAUDE_AUTH_ENV_CONFLICT_MESSAGE)
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
      wslExecution: ctx.wslGuest?.execution,
      launchAgent: isTuiAgent(args.launchAgent) ? args.launchAgent : undefined
    })) ?? null
  ctx.selectedCodexHomePath =
    !ctx.preAdoptedStablePane &&
    !args.connectionId &&
    (!ctx.wslGuest || ctx.wslGuest.fresh || ctx.wslGuest.coldRestore)
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
            wslExecution: ctx.wslGuest?.execution,
            launchAgent: 'codex'
          })) ?? null
        ),
      resolveAfterUnavailable: async (unavailableManagedHomePath) =>
        getCompatibleSelectedCodexHomePath(
          ctx.codexSelectionTarget,
          (await ctx.deps.getSelectedCodexHomePath?.(ctx.codexSelectionTarget, ctx.env, {
            workspacePath: ctx.cwd,
            wslExecution: ctx.wslGuest?.execution,
            launchAgent: 'codex',
            unavailableManagedHomePath
          })) ?? null
        )
    })
    ctx.selectedCodexHomePath = resolution instanceof Promise ? await resolution : resolution
  }
  if (!ctx.wslGuest && args.launchAgent === 'codex' && ctx.selectedCodexHomePath) {
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
  await prepareRuntimeHostSpawnEnvironment(ctx)

  return null
}
