// The provider spawn options both spawn lanes build, from facts each lane resolves its own way.

import { getAppEnvironment } from '../../../shared/app-environment'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { withCodexTerminalServerIsolationEnv } from '../../../shared/codex-terminal-server-isolation'
import { getLegacyOpenCodeEnvKeysToDelete } from '../../opencode/legacy-shared-config-dir'
import { prepareOpenCodePtyLaunch } from '../../opencode/opencode-pty-launch'
import { LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS } from '../../pty/legacy-terminal-shim-dir'
import { PI_PROCESS_OWNER_ENV_KEYS } from '../../pty/pi-process-owner-env'
import { planCodexNoDaemonLaunch } from '../../pty/codex-no-daemon-launch-command'
import { applyAgentWorkspaceTrustToSpawn } from '../../agent-workspace-trust-spawn'
import type { PtySpawnOptions } from '../../providers/pty-provider-contract'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'
import { getStartupTerminalIngressIntent } from '../terminal-startup-color-query-replies'
import { CODEX_HOME_ENV_KEYS } from './host-env/codex-home'
import {
  mergePtyEnvDeletions,
  removeCodexHomeDeletionRequests,
  getInheritedAgentHookEnvKeysToDelete,
  getInheritedAgentSessionStampEnvKeysToDelete
} from './host-env/pi-agent'
import { promoteAgentTeamsShimPath, deleteRequestedEnvKeys } from './host-env/path'
import { resolveConfiguredTerminalShellArgs } from './configured-terminal-shell-args'
import { ptySizes } from './delivery/visibility-state'
import { shouldSeedPreAttachPtySize } from './delivery/attached-pty-size'

type TrustInput = Parameters<typeof applyAgentWorkspaceTrustToSpawn>[0]

/** Carries deletions to provider-owned environments, including persistent older daemons. */
export function assemblePtySpawnEnvDeletions(input: {
  env: Record<string, string> | undefined
  callerEnvToDelete: string[] | undefined
  /** Window only: an Agent Teams refresh drops TERM_PROGRAM; host callers pre-merge their own. */
  agentTeamsEnvToDelete: readonly string[]
  isDaemonHostSpawn: boolean
  connectionId: string | null | undefined
  skipCodexHomeEnv: boolean
  stripInheritedOrcaCodexHome: boolean
  codexResumeHomeSelected: boolean
  settings: GlobalSettings | undefined
}): { env: Record<string, string> | undefined; envToDelete: string[] } {
  // Why here: every provider (local, daemon, SSH relay, WSL) spawns from this env.
  const env = withCodexTerminalServerIsolationEnv(input.env, input.settings)
  let envToDelete =
    mergePtyEnvDeletions(
      input.callerEnvToDelete ?? [],
      // Persistent daemons and older SSH hosts must not resurrect a parent Pi's ownership.
      PI_PROCESS_OWNER_ENV_KEYS,
      input.agentTeamsEnvToDelete,
      // Why: disable old hosts without removing ORCA_REAL_* while their Windows shim remains on PATH.
      input.isDaemonHostSpawn || input.connectionId ? LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS : [],
      input.isDaemonHostSpawn ? getInheritedAgentHookEnvKeysToDelete(env) : [],
      // The daemon must judge its own inherited value; main may have a different config.
      !input.connectionId && !input.isDaemonHostSpawn
        ? getLegacyOpenCodeEnvKeysToDelete(env, getAppEnvironment().getPath('userData'))
        : [],
      // Why: ungated, unlike the agent-hook keys — the local provider and the relay host also spread their own process.env into every spawn.
      getInheritedAgentSessionStampEnvKeysToDelete(env),
      input.skipCodexHomeEnv ? CODEX_HOME_ENV_KEYS : [],
      // Why: the persistent daemon compares its own merged CODEX_HOME pair;
      // main cannot safely decide ownership for a process it may not parent.
      input.stripInheritedOrcaCodexHome ? ['ORCA_CODEX_HOME'] : []
    ) ?? []
  if (input.codexResumeHomeSelected) {
    envToDelete = removeCodexHomeDeletionRequests(envToDelete) ?? []
  }
  deleteRequestedEnvKeys(env, envToDelete)
  return { env, envToDelete }
}

export type PtySpawnLaunchOptionsInput = {
  args: {
    cols: number
    rows: number
    launchAgent?: unknown
    command?: string
    commandDelivery?: PtySpawnOptions['commandDelivery']
    startupCommandDelivery?: PtySpawnOptions['startupCommandDelivery']
    worktreeId?: string
    tabId?: unknown
    connectionId?: string | null
    shellOverride?: string
    telemetry?: { agent_kind?: unknown }
  }
  env: Record<string, string> | undefined
  /** Mutated: OpenCode prep may add the keys its launch must drop. */
  envToDelete: string[]
  launchCommand: string | undefined
  cwd: string | undefined
  /** Window only: the renderer validated cwd; a daemon re-validates it in its own process. */
  prevalidatedCwd?: string
  isDaemonHostSpawn: boolean
  preAdoptedStablePane: boolean
  isNewSession: boolean
  codexRuntime: CodexAccountSelectionTarget['runtime']
  expectedWslDistro: string | null
  requestedAgentTeamsPath: string | undefined
  selectedCodexHomePath: string | null
  shellOverride: string | undefined
  paneKey: string | null | undefined
  sessionId: string | undefined
  /** Each lane's own admission rule for which caller intents reach the provider. */
  spawnIntent: PtySpawnOptions['spawnIntent']
  /** Host history is sampled before preparation; otherwise read it after OpenCode preparation. */
  historyIsolationEnabled?: boolean
  getSettings?: () => GlobalSettings | undefined
  store: TrustInput['store']
  claudeAuth: TrustInput['claudeAuth']
}

/** Builds every provider field both lanes share; lane-only fields are added by the caller. */
export async function assemblePtySpawnLaunchOptions(input: PtySpawnLaunchOptionsInput): Promise<{
  spawnOptions: PtySpawnOptions
  env: Record<string, string> | undefined
  launchCommand: string | undefined
}> {
  const { args } = input
  const connectionId = args.connectionId ?? undefined
  const launchAgent = isTuiAgent(args.launchAgent) ? args.launchAgent : undefined
  const openCodeLaunch = await prepareOpenCodePtyLaunch({
    command: input.launchCommand,
    agent: launchAgent,
    env: input.env,
    envToDelete: input.envToDelete,
    cwd: input.cwd,
    connectionId,
    isFreshLaunch: !input.preAdoptedStablePane && input.launchCommand !== undefined,
    ...(input.codexRuntime === 'wsl'
      ? { wsl: { distro: input.expectedWslDistro ?? undefined } }
      : {})
  })
  const env = openCodeLaunch.env
  const launchCommand = openCodeLaunch.command
  promoteAgentTeamsShimPath(env, input.requestedAgentTeamsPath)
  const spawnOptions: PtySpawnOptions = {
    cols: args.cols,
    rows: args.rows,
    cwd: input.cwd,
    ...(input.prevalidatedCwd && !input.isDaemonHostSpawn
      ? { prevalidatedCwd: input.prevalidatedCwd }
      : {}),
    env,
    historyIsolationEnabled:
      input.historyIsolationEnabled ??
      input.getSettings?.()?.terminalScopeHistoryByWorktree ??
      true,
    ...(input.isNewSession ? { isNewSession: true } : {}),
    envToDelete: input.envToDelete
  }
  if (!connectionId && !input.isDaemonHostSpawn) {
    spawnOptions.codexHomePathOverride = { value: input.selectedCodexHomePath }
  }
  const noDaemonLaunch = planCodexNoDaemonLaunch({
    command: launchCommand,
    executesOnThisHost: !connectionId && input.codexRuntime !== 'wsl',
    shellOverride: input.shellOverride,
    env,
    envToDelete: input.envToDelete,
    cwd: input.cwd
  })
  const command = noDaemonLaunch ? await noDaemonLaunch : launchCommand
  if (command !== undefined) {
    spawnOptions.command = command
  }
  if (args.commandDelivery !== undefined) {
    spawnOptions.commandDelivery = args.commandDelivery
  }
  if (args.startupCommandDelivery !== undefined) {
    spawnOptions.startupCommandDelivery = args.startupCommandDelivery
  }
  if (launchAgent) {
    spawnOptions.launchAgent = launchAgent
  }
  if (args.worktreeId !== undefined) {
    spawnOptions.worktreeId = args.worktreeId
  }
  if (input.spawnIntent) {
    spawnOptions.spawnIntent = input.spawnIntent
  }
  const startupIngress = getStartupTerminalIngressIntent(args)
  if (startupIngress) {
    spawnOptions.startupIngress = startupIngress
  }
  const trustWrite = applyAgentWorkspaceTrustToSpawn({
    launchAgent: args.launchAgent,
    worktreeId: args.worktreeId,
    cwd: input.cwd,
    store: input.store,
    isFreshLaunch: !input.preAdoptedStablePane && launchCommand !== undefined,
    settings: input.getSettings?.(),
    env,
    claudeAuth: input.claudeAuth,
    wslDistro: input.expectedWslDistro,
    connectionId: connectionId ?? null,
    spawnOptions
  })
  if (trustWrite) {
    await trustWrite
  }
  if (input.paneKey) {
    spawnOptions.paneKey = input.paneKey
  }
  if (typeof args.tabId === 'string' && args.tabId.length > 0 && args.tabId.length <= 512) {
    spawnOptions.tabId = args.tabId
  }
  if (input.sessionId !== undefined) {
    spawnOptions.sessionId = input.sessionId
  }
  if (!connectionId) {
    // Why: without this, the Windows daemon path ignores the user's Default Shell preference (LocalPtyProvider already honors it via getWindowsShell()).
    if (input.shellOverride !== undefined) {
      spawnOptions.shellOverride = input.shellOverride
    }
    spawnOptions.terminalShellArgs = resolveConfiguredTerminalShellArgs({
      connectionId,
      requestedShellOverride: args.shellOverride,
      launchCommand,
      settings: input.getSettings?.()
    })
    if (process.platform === 'win32') {
      // Why: the renderer models PowerShell as one shell family; thread the implementation choice so both PTY paths resolve the same executable.
      spawnOptions.terminalWindowsWslDistro = input.expectedWslDistro
      spawnOptions.terminalWindowsPowerShellImplementation = input.getSettings
        ? (input.getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
        : undefined
    }
  }
  return { spawnOptions, env, launchCommand }
}

/**
 * Seeds a session's size before the provider spawns, and returns what was cached so a lost
 * reservation race can restore it.
 */
export function seedPtySpawnSize(input: {
  sessionId: string | undefined
  sessionAppId: string | undefined
  isFreshSessionId: boolean
  /** TEMPORARY (C5e/C6 decide who seeds): window hidden requests are unmeasured; host requests never are. */
  requestIsUnmeasured: boolean
  cols: number
  rows: number
}): {
  hadSessionSizeBeforeAttach: boolean
  sessionSizeBeforeAttach: { cols: number; rows: number } | undefined
} {
  const hadSessionSizeBeforeAttach =
    input.sessionAppId !== undefined ? ptySizes.has(input.sessionAppId) : false
  const sessionSizeBeforeAttach =
    input.sessionAppId !== undefined ? ptySizes.get(input.sessionAppId) : undefined
  if (
    input.sessionId !== undefined &&
    shouldSeedPreAttachPtySize({
      isFreshSessionId: input.isFreshSessionId,
      hasCachedSize: hadSessionSizeBeforeAttach,
      requestIsUnmeasured: input.requestIsUnmeasured
    })
  ) {
    // Why: daemon PTYs can emit before spawn() resolves; set real geometry now or early bytes default to 80x24 and wrap TUIs.
    ptySizes.set(input.sessionAppId ?? input.sessionId, { cols: input.cols, rows: input.rows })
  }
  return { hadSessionSizeBeforeAttach, sessionSizeBeforeAttach }
}

/** Undoes a provisional size seed after a failed start, or a lost race that reattaches to another id. */
export function restoreProvisionalPtySize(input: {
  sessionId: string | undefined
  sessionAppId: string | undefined
  /** Set when a lost reservation race reattached; the winner may have committed this id's real size. */
  reattachId?: string
  hadSessionSizeBeforeAttach: boolean
  sessionSizeBeforeAttach: { cols: number; rows: number } | undefined
}): void {
  if (input.sessionId === undefined) {
    return
  }
  const provisionalSizeKey = input.sessionAppId ?? input.sessionId
  if (provisionalSizeKey === input.reattachId) {
    return
  }
  if (input.hadSessionSizeBeforeAttach && input.sessionSizeBeforeAttach) {
    ptySizes.set(provisionalSizeKey, input.sessionSizeBeforeAttach)
  } else {
    ptySizes.delete(provisionalSizeKey)
  }
}
