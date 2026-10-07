import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  resolveCliCommand,
  resolveExecutableCommand
} from '../../shared/node-cli-command-resolution'
import {
  hasExplicitTuiLaunchCommand,
  structuredAgentCommandToken
} from '../../shared/tui-agent-launch-command-override'
import { AgentSessionPreSpawnError } from './agent-session-wire/structured-agent-session-adapter'

type CommandSettings = Partial<Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultEnv'>>
type CommandOptions = NonNullable<Parameters<typeof resolveExecutableCommand>[1]>

function resolveOverride(
  agent: TuiAgent,
  settings: CommandSettings | null | undefined,
  options: CommandOptions
) {
  const token = structuredAgentCommandToken(settings?.agentCmdOverrides?.[agent] ?? '')
  const overlay = settings?.agentDefaultEnv?.[agent]
  return token
    ? resolveExecutableCommand(token, {
        ...options,
        pathEnv: options.pathEnv ?? overlay?.PATH ?? overlay?.Path
      })
    : null
}

// Windows starts .exe/.com directly and .cmd/.bat through Orca's shim handling; an extensionless
// file would fail to spawn with no word about the setting.
function spawnableOn(platform: NodeJS.Platform, command: string): boolean {
  return platform !== 'win32' || /\.(exe|com|cmd|bat)$/i.test(command)
}

/** Re-read the existing setting for every session acquisition and catalog probe. A set Command
 *  that names no runnable program refuses the start rather than quietly running the stock CLI. */
export function resolveStructuredAgentCommand(
  agent: 'claude' | 'codex',
  settings: CommandSettings,
  options: CommandOptions = {}
): string {
  if (!hasExplicitTuiLaunchCommand(settings, agent)) {
    return resolveCliCommand(agent, options)
  }
  const command = resolveOverride(agent, settings, options)
  if (!command || !spawnableOn(options.platform ?? process.platform, command)) {
    // The value stays out of the message: a saved command line can carry a secret.
    throw new AgentSessionPreSpawnError(`the ${agent} Command setting is not a runnable program`, {
      reason: 'agentCommandNotRunnable'
    })
  }
  return command
}
