import type { PreflightRuntimeContext } from '../preflight/agent-detection'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'
import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'

export async function resolveQoderTerminalCommandForWorkspace(
  launch: TerminalCreateOptions,
  workspace: TerminalWorkspaceLaunchScope,
  store: RuntimeStore | null | undefined,
  platform: NodeJS.Platform
): Promise<TerminalCreateOptions> {
  if (launch.launchAgent !== 'qoder') {
    return launch
  }
  return resolveQoderTerminalCommand(launch, {
    connectionId: workspace.connectionId,
    context:
      !workspace.connectionId && store
        ? {
            projectRuntime: resolveLocalProjectRuntimeForWorktreeId(store, workspace.id),
            wslDistro: parseWslUncPath(workspace.path)?.distro
          }
        : undefined,
    shell: resolveStartupShell(
      platform,
      resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote: Boolean(workspace.connectionId),
        terminalWindowsShell: launch.shellOverride ?? store?.getSettings().terminalWindowsShell
      })
    )
  })
}

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
            agentCommand: options.launchConfig.agentCommand?.replace(/^qodercli(?=\s|$)/, selected)
          }
        }
      : {})
  }
}
