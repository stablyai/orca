import type { PreflightRuntimeContext } from '../preflight/agent-detection'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

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
  if (options.launchAgent !== 'qoder' || !options.command) {
    return options
  }
  const parsed = tokenizeStartupCommand(options.command, host.shell)
  // Explicit paths and configured recipes remain owned by the caller.
  if (!parsed.ok) {
    return options
  }
  const executableIndex = parsed.tokens.findIndex(
    (token, index) =>
      token === TUI_AGENT_CONFIG.qoder.detectCmd &&
      (index === 0 ||
        parsed.tokens[index - 1] === '&&' ||
        (parsed.tokens[0] === 'Set-Location' && parsed.tokens[index - 1].endsWith(';')))
  )
  if (executableIndex === -1) {
    return options
  }
  const candidates = getTuiAgentDetectCommands(TUI_AGENT_CONFIG.qoder)
  // Discovery is optional; its failure must not prevent the caller's command from running.
  const found = await detect(candidates, host).catch(() => new Set<string>())
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
            agentCommand: options.launchConfig.agentCommand?.replace(/^qodercli(?=\s|$)/, selected)
          }
        }
      : {})
  }
}
