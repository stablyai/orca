import { getAgentLaunchExecutableName } from '../../shared/agent-command-line-intent'
import {
  isAgentStatusHooksEnabledForAgent,
  type AgentStatusHooksSettings
} from '../../shared/agent-status-hooks-setting'
import type { ClaudeAgentViewSettings } from '../../shared/claude-agent-view'
import {
  detectExplicitPiAgentKindFromCommand,
  isPiCompatibleAgentType,
  type PiAgentKind
} from '../../shared/pi-agent-kind'
import type { TuiAgent } from '../../shared/tui-agent'
import { wslHookRelayManager, type WslHookRelayManager } from './wsl-hook-relay-manager'

export async function awaitExplicitAgentPluginGuestReadiness(args: {
  isWsl: boolean
  distro: string | null | undefined
  codexHomePath?: string | null
  launchAgent?: TuiAgent
  launchCommand?: string
  settings?: AgentStatusHooksSettings & ClaudeAgentViewSettings
  timeoutMs?: number
  manager?: Pick<
    WslHookRelayManager,
    'ensureForDistro' | 'getGuestEndpointFilePath' | 'getGuestAgentPath'
  > &
    Partial<Pick<WslHookRelayManager, 'getClaudeAgentView'>>
}): Promise<boolean> {
  if (!args.isWsl) {
    return true
  }
  const kind: PiAgentKind | null = isPiCompatibleAgentType(args.launchAgent)
    ? args.launchAgent
    : detectExplicitPiAgentKindFromCommand(args.launchCommand)
  const claude =
    args.settings?.claudeSubagentNavigationEnabled !== false &&
    isAgentStatusHooksEnabledForAgent(args.settings, 'claude') &&
    (args.launchAgent === 'claude' ||
      (!args.launchAgent && getAgentLaunchExecutableName(args.launchCommand) === 'claude'))
  if (kind !== 'pi' && kind !== 'omp' && !claude) {
    return true
  }
  const distro = args.distro ?? null
  const manager = args.manager ?? wslHookRelayManager
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      manager
        .ensureForDistro(
          distro,
          args.codexHomePath,
          kind === 'pi' || kind === 'omp' ? kind : undefined
        )
        .then(() =>
          Boolean(
            manager.getGuestEndpointFilePath(distro) &&
            (claude
              ? manager.getClaudeAgentView?.(distro)
              : (kind === 'pi' || kind === 'omp') && manager.getGuestAgentPath(distro, kind))
          )
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), args.timeoutMs ?? 10_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
