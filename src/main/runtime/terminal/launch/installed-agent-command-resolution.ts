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
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalCreateOptions } from './terminal-create-options'

/** Agents that ship one CLI under several command names; the launch runs whichever the host has. */
const INSTALLED_COMMAND_AGENTS: ReadonlySet<string> = new Set<TuiAgent>(['qoder', 'aiwork'])

/** Whether the agent's launch command is rewritten to the command name installed on the host. */
export function resolvesInstalledAgentCommand(agent: string | null | undefined): boolean {
  return agent != null && INSTALLED_COMMAND_AGENTS.has(agent)
}

/** Rewrites the launch to the agent's installed command name; unchanged when the default is present or none is found. */
export async function resolveInstalledAgentTerminalCommand<
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
  const agent = options.launchAgent
  if (!agent || !resolvesInstalledAgentCommand(agent) || !options.command) {
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
            agentCommand: replaceLeadingCommand(
              options.launchConfig.agentCommand,
              config.detectCmd,
              selected
            )
          }
        }
      : {})
  }
}

/** Swaps `from` for `to` only when it is the whole leading command word. */
function replaceLeadingCommand(
  command: string | null | undefined,
  from: string,
  to: string
): string | null | undefined {
  return command && (command === from || command.startsWith(`${from} `))
    ? to + command.slice(from.length)
    : command
}
