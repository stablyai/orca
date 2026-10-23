import { withClaudeProfileTerminalEnv } from '../../../claude-accounts/claude-profile-installed-router'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { getProvider } from '../provider/registry'
import {
  isClaudeLaunchCommand,
  recoverFreshSpawnProviderRouting,
  routesFreshSpawnsToLocalProvider
} from '../host-env/fresh-spawn-routing'
import {
  mintPtySessionId,
  ptySessionIdForAgentCreateOperation
} from '../../../daemon/pty-session-id'
import { resolvePathEnvKey } from '../../../pty/windows-environment-path'
import type { RuntimePtySpawnState } from './spawn-state'
import { resolvePtySpawnStartupTarget } from '../spawn-startup-target'
import { resolvePtySpawnHostEnv } from '../spawn-host-env'
import { ptySpawnPaneFromIds, stampPtySpawnPaneEnv } from '../spawn-pane-env'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import {
  ensureJcodeRuntimeDir,
  JCODE_RUNTIME_DIR_ENV_KEY
} from '../../../../shared/jcode-runtime-dir'

export async function prepareRuntimePtySpawn(
  ctx: RuntimePtySpawnState
): Promise<PtySpawnResult | null> {
  const args = ctx.args
  if (!ctx.preAdoptedStablePane) {
    const admission = ctx.deps.assertWorkspaceAcceptsNewPty(args.worktreeId, args.sessionId)
    if (admission) {
      await admission
    }
  }
  // Only this machine spawns here: an `ssh:` connection throws, so every line below is local.
  ctx.provider = getProvider(getConnectionExecutionHostId(args.connectionId))
  const freshSpawnRecovery = ctx.preAdoptedStablePane
    ? undefined
    : recoverFreshSpawnProviderRouting(ctx.provider, args.sessionId, args.isNewSession)
  if (freshSpawnRecovery) {
    await freshSpawnRecovery
  }
  ctx.isClaudeLaunch = !ctx.preAdoptedStablePane && isClaudeLaunchCommand(args.command)
  ctx.isDaemonHostSpawn =
    !(ctx.provider instanceof LocalPtyProvider) && !routesFreshSpawnsToLocalProvider(ctx.provider)
  ctx.callerRequestedSessionId = args.sessionId?.trim()
  ctx.requestedSessionId =
    ctx.callerRequestedSessionId ??
    (ctx.isDaemonHostSpawn && args.agentSessionCreateOperationId
      ? ptySessionIdForAgentCreateOperation(args.worktreeId, args.agentSessionCreateOperationId)
      : undefined)
  ctx.sessionId =
    ctx.requestedSessionId ??
    (ctx.isDaemonHostSpawn ? mintPtySessionId(args.worktreeId) : undefined)
  ctx.effectiveSessionAppId = ctx.sessionId
  ctx.isNewDaemonSession =
    !ctx.preAdoptedStablePane &&
    ctx.isDaemonHostSpawn &&
    (ctx.callerRequestedSessionId === undefined || args.isNewSession === true)
  // Why: runtime-created terminals carry no renderer projectRuntime. An agent launch brings the PTY
  // its command was quoted for; anything else takes the project's runtime and `--shell` pick.
  const target = await resolvePtySpawnStartupTarget({
    worktreeId: args.worktreeId,
    cwd: args.cwd,
    sessionId: ctx.sessionId,
    shellOverride: args.shellOverride,
    plannedPty: args.launchRuntime?.pty,
    projectRuntimeSource: { kind: 'store', store: ctx.deps.store },
    preAdopted: ctx.preAdoptedStablePane !== null,
    getSettings: ctx.deps.getSettings,
    resolveStartupCwd: ctx.deps.resolvePtySpawnStartupCwd
  })
  ctx.cwd = target.cwd
  ctx.requestedCwd = target.requestedCwd
  ctx.prevalidatedCwd = target.prevalidatedCwd
  ctx.startupCwdFallback = target.startupCwdFallback
  ctx.correctStartupCwd = target.correctStartupCwd
  ctx.terminalRuntimeOptions = target.terminalRuntimeOptions
  ctx.daemonShellOverride = ctx.terminalRuntimeOptions.shellOverride
  ctx.expectedWslDistro = target.expectedWslDistro
  ctx.codexSelectionTarget = target.codexSelectionTarget
  args.env = withClaudeProfileTerminalEnv(args.env, ctx.codexSelectionTarget)
  ctx.claudeAuth =
    ctx.isClaudeLaunch && ctx.deps.prepareClaudeAuth
      ? await ctx.deps.prepareClaudeAuth(ctx.codexSelectionTarget)
      : null

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
      ...(args.expectedSourceBinding ? { expectedSourceBinding: args.expectedSourceBinding } : {}),
      ...(args.placement ? { placement: args.placement } : {})
    }
  }
  ctx.env = ctx.claudeAuth ? { ...args.env, ...ctx.claudeAuth.envPatch } : args.env
  ctx.requestedAgentTeamsPath = ctx.env?.ORCA_AGENT_TEAMS_TEAM_ID
    ? ctx.env[resolvePathEnvKey(ctx.env, process.platform)]
    : undefined
  if (args.preAllocatedHandle) {
    ctx.env = { ...ctx.env, ORCA_TERMINAL_HANDLE: args.preAllocatedHandle }
  }
  if (ctx.env) {
    // Why a copy: without a handle or Claude auth this is still the caller's env, which a split reuses.
    ctx.env = { ...ctx.env }
    const pane = ptySpawnPaneFromIds(args)
    const jcodeEnv = pane ? await ensureJcodeRuntimeDir(pane.paneKey) : undefined
    stampPtySpawnPaneEnv(ctx.env, {
      pane,
      jcodeRuntimeDir: jcodeEnv?.[JCODE_RUNTIME_DIR_ENV_KEY]
    })
  }
  const hostEnv = await resolvePtySpawnHostEnv({
    launchAgent: args.launchAgent,
    command: args.command,
    resumeProviderSession: args.resumeProviderSession,
    env: ctx.env,
    cwd: ctx.cwd,
    shellOverride: ctx.daemonShellOverride,
    expectedWslDistro: ctx.expectedWslDistro,
    codexSelectionTarget: ctx.codexSelectionTarget,
    preAdopted: Boolean(ctx.preAdoptedStablePane),
    isDaemonHostSpawn: ctx.isDaemonHostSpawn,
    sessionId: ctx.sessionId,
    callerNamedSession: ctx.callerRequestedSessionId !== undefined,
    mintedSessionId: ctx.requestedSessionId === undefined,
    resumeOnSelectedAccount: false,
    emptySessionIdSkipsHostEnv: true,
    requestedAgentTeamsPath: ctx.requestedAgentTeamsPath,
    provider: ctx.provider,
    deps: ctx.deps
  })
  ctx.launchCommand = hostEnv.launchCommand
  ctx.codexResumeArgvDropped = hostEnv.codexResumeLaunch.droppedResumeArgv
  ctx.codexResumeUnavailable = hostEnv.codexResumeLaunch.notifyResumeUnavailable
  ctx.env = hostEnv.env
  ctx.selectedCodexHomePath = hostEnv.selectedCodexHomePath
  ctx.codexResumeHomeSelected = hostEnv.codexResumeHomeSelected
  ctx.skipCodexHomeEnv = hostEnv.skipCodexHomeEnv
  ctx.stripInheritedOrcaCodexHome = hostEnv.stripInheritedOrcaCodexHome

  return null
}
