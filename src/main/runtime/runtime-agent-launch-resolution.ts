import { createHash } from 'node:crypto'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { ClaudeAgentTeamsMode } from '../../shared/claude-agent-teams-tmux-compat'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import {
  executionRuntimePlatform,
  remoteExecutionPlatform
} from '../../shared/agent-launch-runtime'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { isLaunchConfigClaudeAccountId } from '../../shared/claude/project-claude-account-preference'

/**
 * Account fields a background terminal create forwards to the PTY spawn: an explicit `--account`,
 * else the launch config's recorded choice, which the spawn resolves below any explicit pin.
 */
export function terminalCreateClaudeAccountIdField(launchOpts: {
  claudeAccountId?: string
  launchClaudeAccountId?: string
  launchConfig?: Pick<SleepingAgentLaunchConfig, 'claudeAccountId'>
}): { claudeAccountId?: string; launchConfigClaudeAccountId?: string } {
  if (launchOpts.claudeAccountId) {
    return { claudeAccountId: launchOpts.claudeAccountId }
  }
  const recorded = launchOpts.launchConfig?.claudeAccountId ?? launchOpts.launchClaudeAccountId
  return isLaunchConfigClaudeAccountId(recorded) ? { launchConfigClaudeAccountId: recorded } : {}
}

/** Records the launch's Claude account on its config, so a resume replays it as a saved choice. */
export function withRecordedClaudeAccount(
  config: SleepingAgentLaunchConfig | undefined,
  launchOpts: { claudeAccountId?: string; launchClaudeAccountId?: string; launchAgent?: TuiAgent }
): SleepingAgentLaunchConfig | undefined {
  const accountId = launchOpts.claudeAccountId ?? launchOpts.launchClaudeAccountId
  return config && accountId && launchOpts.launchAgent === 'claude'
    ? { ...config, claudeAccountId: accountId }
    : config
}

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
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {}),
    ...(config.claudeAccountId ? { claudeAccountId: config.claudeAccountId } : {})
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
  return repo.connectionId
    ? remoteExecutionPlatform(repo.path)
    : executionRuntimePlatform(projectRuntime, undefined, process.platform)
}
