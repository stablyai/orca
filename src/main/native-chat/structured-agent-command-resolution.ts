import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  resolveCliCommand,
  resolveExecutableCommand
} from '../../shared/node-cli-command-resolution'
import { structuredAgentCommandToken } from '../../shared/tui-agent-launch-command-override'

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

/** Re-read the existing setting for every session acquisition and catalog probe. */
export function resolveStructuredAgentCommand(
  agent: 'claude' | 'codex',
  settings: CommandSettings,
  options: CommandOptions = {}
): string {
  return resolveOverride(agent, settings, options) ?? resolveCliCommand(agent, options)
}
