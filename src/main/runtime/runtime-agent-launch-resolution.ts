import { createHash } from 'node:crypto'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { ClaudeAgentTeamsMode } from '../../shared/claude-agent-teams-tmux-compat'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'

export function mergeTerminalEnvDeletionKeys(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): string[] | undefined {
  const merged = [...new Set([...(first ?? []), ...(second ?? [])])]
  return merged.length > 0 ? merged : undefined
}

export function isAgentSessionOperationOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'agentSessionOperationOutcome' in error &&
    error.agentSessionOperationOutcome === 'unknown'
  )
}

export function deterministicAgentSessionUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function copySleepingAgentLaunchConfig(
  config: SleepingAgentLaunchConfig
): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv },
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {})
  }
}

export function normalizeAgentLaunchCommandForMatch(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

export function resolveBareAgentLaunchCommand(args: {
  command: string | undefined
  settings: {
    agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
    disabledTuiAgents?: Iterable<unknown> | null
  }
  platform: NodeJS.Platform
  isRemote: boolean
}): TuiAgent | null {
  const command = args.command ? normalizeAgentLaunchCommandForMatch(args.command) : ''
  if (!command) {
    return null
  }

  const cmdOverrides = args.settings.agentCmdOverrides ?? {}
  for (const agent of Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]) {
    if (!isTuiAgentEnabled(agent, args.settings.disabledTuiAgents)) {
      continue
    }
    const override = cmdOverrides[agent]?.trim()
    const defaultLaunchCommand = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], args.platform, {
      isRemote: args.isRemote
    })
    const launchCommands = override ? [defaultLaunchCommand, override] : [defaultLaunchCommand]
    if (
      launchCommands.some((candidate) => command === normalizeAgentLaunchCommandForMatch(candidate))
    ) {
      return agent
    }
  }

  return null
}

export function inferCapturedClaudeAgentTeamsMode(
  launchConfig: SleepingAgentLaunchConfig | undefined,
  command: string | undefined,
  currentMode: ClaudeAgentTeamsMode | undefined
): ClaudeAgentTeamsMode | undefined {
  const capturedCommand = launchConfig?.agentCommand?.trim() || command?.trim() || ''
  const capturedArgs = launchConfig?.agentArgs?.trim() ?? ''
  const capturedLaunch = `${capturedCommand} ${capturedArgs}`.trim()
  if (/(^|\s)--teammate-mode(?:=|\s+)auto(?:\s|$)/.test(capturedLaunch)) {
    return 'native-panes-shim'
  }
  if (/(^|\s)--teammate-mode(?:=|\s+)in-process(?:\s|$)/.test(capturedLaunch)) {
    return 'in-process'
  }
  if (launchConfig && /(^|\s)--resume(?:\s|=|$)/.test(command?.trim() ?? '')) {
    return 'off'
  }
  return currentMode
}

export function getAgentLaunchPlatformForRepo(
  repo: Pick<Repo, 'connectionId' | 'path'>,
  projectRuntime?: ProjectExecutionRuntimeResolution
): NodeJS.Platform {
  if (!repo.connectionId) {
    if (projectRuntime?.status === 'repair-required') {
      return projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : process.platform
    }
    if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
      return 'linux'
    }
    return process.platform
  }
  return isWindowsAbsolutePathLike(repo.path) ? 'win32' : 'linux'
}
