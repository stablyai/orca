import type { PreflightRuntimeContext } from '../../../ipc/preflight-runtime-target'
import { detectAgentCommandsOnHost } from '../../../preflight/agent-command-detection'
import {
  getTuiAgentDetectCommands,
  TUI_AGENT_CONFIG
} from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { TerminalCreateOptions } from './terminal-create-options'

// Agents that ship under more than one command name; the launch uses whichever the host has.
const ALIASED_COMMAND_AGENTS = ['qoder', 'cursor'] as const

export async function resolveQoderTerminalCommand<
  T extends Pick<TerminalCreateOptions, 'launchAgent' | 'command' | 'launchConfig'>
>(
  options: T,
  host: {
    connectionId?: string | null
    context?: PreflightRuntimeContext
    shell: AgentStartupShell
  },
  detect = detectAgentCommandsOnHost
): Promise<T> {
  const agent = ALIASED_COMMAND_AGENTS.find((candidate) => candidate === options.launchAgent)
  if (!agent || !options.command) {
    return options
  }
  const config = TUI_AGENT_CONFIG[agent]
  const parsed = tokenizeStartupCommand(options.command, host.shell)
  // Explicit paths and configured recipes remain owned by the caller.
  if (!parsed.ok) {
    return options
  }
  const executableIndex = parsed.tokens.findIndex(
    (token, index) =>
      token === config.detectCmd &&
      (index === 0 ||
        parsed.tokens[index - 1] === '&&' ||
        (parsed.tokens[0] === 'Set-Location' && parsed.tokens[index - 1].endsWith(';')))
  )
  if (executableIndex === -1) {
    return options
  }
  const candidates = getTuiAgentDetectCommands(config)
  const found = await detect(candidates, host)
  const selected = candidates.find((candidate) => found.has(candidate))
  if (!selected || selected === parsed.tokens[executableIndex]) {
    return options
  }
  const first = parsed.spans[executableIndex]
  if (!first) {
    return options
  }
  return {
    ...options,
    command: options.command.slice(0, first.start) + selected + options.command.slice(first.end),
    ...(options.launchConfig
      ? {
          launchConfig: {
            ...options.launchConfig,
            agentCommand: options.launchConfig.agentCommand?.replace(
              new RegExp(`^${config.detectCmd}(?=\\s|$)`),
              selected
            )
          }
        }
      : {})
  }
}
