import { delimiter, isAbsolute, resolve as resolvePath } from 'node:path'
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
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError
} from './agent-session-wire/structured-agent-session-adapter'
import { guestNativePathEnv } from '../ipc/wsl-guest-windows-drive-path'

export type StructuredAgentCommandSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultEnv'>
>
type CommandSettings = StructuredAgentCommandSettings
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
        pathEnv: guestNativePathEnv(options.pathEnv ?? overlay?.PATH ?? overlay?.Path)
      })
    : null
}

// Windows starts .exe/.com directly and .cmd/.bat through Orca's shim handling; an extensionless
// file would fail to spawn with no word about the setting.
function spawnableOn(platform: NodeJS.Platform, command: string): boolean {
  return platform !== 'win32' || /\.(exe|com|cmd|bat)$/i.test(command)
}

/** Re-read the existing setting for every session acquisition and catalog probe. A set Command
 *  that names no runnable program refuses the start rather than quietly running the stock CLI.
 *  Without one, `stock` names the agent's own binary (the agent id by default). */
export function resolveStructuredAgentCommand(
  agent: TuiAgent,
  settings: CommandSettings,
  options: CommandOptions = {},
  stock: { command?: string; resolve?: typeof resolveCliCommand } = {}
): string {
  if (!hasExplicitTuiLaunchCommand(settings, agent)) {
    // Why: inside a WSL guest the inherited PATH ends in /mnt/<drive> dirs holding Windows shims.
    const pathEnv = guestNativePathEnv(options.pathEnv)
    return (stock.resolve ?? resolveCliCommand)(
      stock.command ?? agent,
      pathEnv === options.pathEnv ? options : { ...options, pathEnv }
    )
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

/** What a lookup searched: the env whose PATH it used, and the directory its program starts in. */
export type ProgramSearch<T> = {
  env: (resolved: T) => NodeJS.ProcessEnv | undefined
  /** Orca's own working directory when absent. */
  cwd?: () => Promise<string> | string
}

/** Whether a lookup found nothing. A bare name back may still be in a relative PATH entry (a
 *  workspace `bin`), which the spawn searches from its own directory and the lookup did not. */
async function foundNothing<T extends { command: string }>(
  resolved: T,
  search: ProgramSearch<T>
): Promise<boolean> {
  if (isAbsolute(resolved.command) || /[\\/]/.test(resolved.command)) {
    return false
  }
  const env = search.env(resolved)
  const relative = (env?.PATH ?? env?.Path ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !isAbsolute(entry))
  if (relative.length === 0) {
    return true
  }
  const from = (await search.cwd?.()) ?? process.cwd()
  const found = resolveCliCommand(resolved.command, {
    pathEnv: relative.map((entry) => resolvePath(from, entry)).join(delimiter),
    homePath: env?.HOME ?? env?.USERPROFILE
  })
  return !isAbsolute(found)
}

/** Resolves a launch's program from the shell snapshot. When nothing is found there (see
 *  `foundNothing`, or a Command setting naming no program), waits for a reread that started after
 *  this lookup did and resolves once more, so an agent installed before it starts. A found
 *  program never waits. */
export async function resolveAgainAfterRefreshOnMissingProgram<T extends { command: string }>(
  resolve: () => Promise<T>,
  refreshAfterMiss: ((askedAt: number) => Promise<void>) | undefined,
  search: ProgramSearch<T>
): Promise<T> {
  if (!refreshAfterMiss) {
    return resolve()
  }
  const askedAt = Date.now()
  try {
    const resolved = await resolve()
    if (!(await foundNothing(resolved, search))) {
      return resolved
    }
  } catch (error) {
    if (!isAgentSessionPreSpawnError(error) || error.reason !== 'agentCommandNotRunnable') {
      throw error
    }
  }
  await refreshAfterMiss(askedAt)
  return resolve()
}
