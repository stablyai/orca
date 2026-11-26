import type {
  AgentProgramBlockReason,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { NativeChatSignInRequest } from '../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { PreselectedAgentProgram } from '../../../managed-agent-cli/managed-agent-spawn-program'
import { preparePtyAgentLaunch } from './prepare-pty-agent-launch'
import { selectPtyAgentLaunch } from './select-pty-agent-launch'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { applyAgentWorkspaceTrustToSpawn } from '../../../agent-launch/trust/agent-workspace-trust-spawn'
import type { PtySpawnOptions } from '../../../providers/pty/provider-contract'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import { getStartupTerminalIngressIntent } from '../host-env/terminal-startup-color-query-replies'
import { resolveConfiguredTerminalShellArgs } from '../host-env/configured-terminal-shell-args'
import { ptySizes } from '../delivery/visibility-state'
import { shouldSeedPreAttachPtySize } from '../delivery/attached-pty-size'
import type { TerminalMcpPaneLaunch } from '../../../mcp-servers/terminal/terminal-mcp-launch'
import { prepareOpenCodePtyLaunch } from '../../../opencode/opencode-pty-launch'

type TrustInput = Parameters<typeof applyAgentWorkspaceTrustToSpawn>[0]

export type PtySpawnLaunchOptionsInput = {
  args: {
    cols: number
    rows: number
    launchAgent?: unknown
    preselectedAgentProgram?: PreselectedAgentProgram
    nativeChatSignIn?: NativeChatSignInRequest
    resumeProviderSession?: unknown
    resumeOrigin?: unknown
    signal?: AbortSignal
    command?: string
    commandDelivery?: PtySpawnOptions['commandDelivery']
    startupCommandDelivery?: PtySpawnOptions['startupCommandDelivery']
    worktreeId?: string
    trustWorktreeId?: string
    tabId?: unknown
    connectionId?: string | null
    shellOverride?: string
    telemetry?: { agent_kind?: unknown }
  }
  env: Record<string, string> | undefined
  /** Mutated: OpenCode prep may add the keys its launch must drop. */
  envToDelete: string[]
  launchCommand: string | undefined
  launchConfig?: SleepingAgentLaunchConfig
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
  headlessHost?: boolean
  getSettings?: () => GlobalSettings | undefined
  store: TrustInput['store']
  claudeAuth: TrustInput['claudeAuth']
}

export async function assemblePtySpawnLaunchOptions(input: PtySpawnLaunchOptionsInput): Promise<{
  spawnOptions: PtySpawnOptions
  env: Record<string, string> | undefined
  launchCommand: string | undefined
  launchConfig?: SleepingAgentLaunchConfig
  blocked?: AgentProgramBlockReason
  /** What the host's MCP server list gave the pane; null when it was left as main leaves it. */
  terminalMcp: TerminalMcpPaneLaunch | null
}> {
  const { args } = input
  const connectionId = args.connectionId ?? undefined
  const selection = await selectPtyAgentLaunch(input)
  const expectedWslDistro = selection.wslDistro
  const openCodeLaunch = await prepareOpenCodePtyLaunch({
    command: selection.startupCommand,
    agent: selection.launchAgent,
    env: selection.paneEnv,
    envToDelete: input.envToDelete,
    cwd: input.cwd,
    connectionId,
    isFreshLaunch:
      !input.preAdoptedStablePane &&
      selection.startupCommand !== undefined &&
      (!selection.postSetupProgram || selection.postSetupProgram.path !== undefined),
    shell: selection.shell,
    ...(input.codexRuntime === 'wsl' ? { wsl: { distro: expectedWslDistro ?? undefined } } : {})
  })
  const {
    env,
    launchAgent,
    launchCommand,
    startup,
    settings,
    terminalMcp,
    launchConfig,
    blocked,
    startupNotice
  } = await preparePtyAgentLaunch({ ...input, expectedWslDistro }, selection, openCodeLaunch)
  const spawnOptions: PtySpawnOptions = {
    cols: args.cols,
    rows: args.rows,
    cwd: input.cwd,
    ...(input.prevalidatedCwd && !input.isDaemonHostSpawn
      ? { prevalidatedCwd: input.prevalidatedCwd }
      : {}),
    env,
    historyIsolationEnabled:
      input.historyIsolationEnabled ?? settings?.terminalScopeHistoryByWorktree ?? true,
    ...(input.isNewSession ? { isNewSession: true } : {}),
    envToDelete: input.envToDelete
  }
  if (!connectionId && !input.isDaemonHostSpawn) {
    spawnOptions.codexHomePathOverride = { value: input.selectedCodexHomePath }
  }
  if (startup !== undefined) {
    spawnOptions.command = startup
  }
  if (startupNotice) {
    spawnOptions.startupNotice = startupNotice
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
    trustWorktreeId: args.trustWorktreeId,
    cwd: input.cwd,
    store: input.store,
    isFreshLaunch: !input.preAdoptedStablePane && launchCommand !== undefined,
    settings: input.getSettings?.(),
    env,
    claudeAuth: input.claudeAuth,
    wslDistro: expectedWslDistro,
    connectionId: connectionId ?? null,
    codexHome: input.selectedCodexHomePath,
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
    // Daemon spawns must honor saved Windows shell preference too.
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
      // Preserve the PowerShell implementation choice across both provider paths.
      spawnOptions.terminalWindowsWslDistro = expectedWslDistro
      spawnOptions.terminalWindowsPowerShellImplementation = input.getSettings
        ? (input.getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto')
        : undefined
    }
  }
  return {
    spawnOptions,
    env,
    launchCommand,
    terminalMcp,
    launchConfig,
    blocked
  }
}

export type PtySpawnSizeSeed = {
  cachedBeforeAttach: { cols: number; rows: number } | undefined
  rollback: (options?: { reattachId?: string; exitedBeforeSpawnReply?: boolean }) => void
}

/** Samples and seeds geometry only when preparation reaches this resource. */
export function seedPtySpawnSize(input: {
  sessionId: string | undefined
  sessionAppId: string | undefined
  isFreshSessionId: boolean
  requestIsUnmeasured: boolean
  cols: number
  rows: number
}): PtySpawnSizeSeed {
  const key = input.sessionAppId ?? input.sessionId
  const cachedBeforeAttach = key !== undefined ? ptySizes.get(key) : undefined
  if (
    input.sessionId !== undefined &&
    shouldSeedPreAttachPtySize({
      isFreshSessionId: input.isFreshSessionId,
      hasCachedSize: cachedBeforeAttach !== undefined,
      requestIsUnmeasured: input.requestIsUnmeasured
    })
  ) {
    // Daemon output can precede the reply; the grid must exist before byte zero.
    ptySizes.set(key!, { cols: input.cols, rows: input.rows })
  }
  return {
    cachedBeforeAttach,
    rollback: (options) => {
      if (input.sessionId === undefined || key === options?.reattachId) {
        return
      }
      if (cachedBeforeAttach && !options?.exitedBeforeSpawnReply) {
        ptySizes.set(key!, cachedBeforeAttach)
      } else {
        ptySizes.delete(key!)
      }
    }
  }
}

/** Takes the acquired seed so teardown and outer failure cannot restore it twice. */
export function restoreProvisionalPtySize(
  state: { provisionalPtySize: PtySpawnSizeSeed | undefined },
  options?: Parameters<PtySpawnSizeSeed['rollback']>[0]
): void {
  const seed = state.provisionalPtySize
  state.provisionalPtySize = undefined
  seed?.rollback(options)
}
