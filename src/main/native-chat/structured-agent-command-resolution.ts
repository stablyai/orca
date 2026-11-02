import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, resolve as resolvePath } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  resolveCliCommand,
  resolveExecutableCommand
} from '../../shared/node-cli-command-resolution'
import {
  hasExplicitTuiLaunchCommand,
  structuredAgentCommandPlan
} from '../../shared/tui-agent-launch-command-override'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError
} from './agent-session-wire/structured-agent-session-adapter'
import { guestNativePathEnv, resolveGuestNativeProgram } from '../ipc/wsl-guest-windows-drive-path'

export type StructuredAgentResolutionOperation = {
  deadline?: number
  current?: () => boolean
  signal?: AbortSignal
}

export function assertStructuredAgentResolutionCurrent(
  operation?: StructuredAgentResolutionOperation
): void {
  operation?.signal?.throwIfAborted()
  if (
    operation?.current?.() === false ||
    (operation?.deadline !== undefined && Date.now() >= operation.deadline)
  ) {
    throw new Error('Agent resolution operation ended')
  }
}

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
  const plan = structuredAgentCommandPlan(
    settings?.agentCmdOverrides?.[agent] ?? '',
    options.platform ?? process.platform
  )
  const overlay = settings?.agentDefaultEnv?.[agent]
  const command = plan
    ? resolveExecutableCommand(plan.program, {
        ...options,
        pathEnv: guestNativePathEnv(options.pathEnv ?? overlay?.PATH ?? overlay?.Path)
      })
    : null
  return command && plan
    ? {
        command,
        prefixArgs: plan.prefixArgs.map((token) =>
          token.startsWith('~/')
            ? resolvePath(options.homePath ?? homedir(), token.slice(2))
            : token
        )
      }
    : null
}

// Extensionless commands cannot spawn on Windows; .cmd/.bat use Orca’s shim handling.
function spawnableOn(platform: NodeJS.Platform, command: string): boolean {
  return platform !== 'win32' || /\.(exe|com|cmd|bat)$/i.test(command)
}

export type StructuredAgentCommand = { command: string; prefixArgs: string[] }

/** Read live settings on every lookup; invalid explicit commands must refuse instead of launching stock CLI. */
export function resolveStructuredAgentCommand(
  agent: TuiAgent,
  settings: CommandSettings,
  options: CommandOptions = {},
  stock: { command?: string; resolve?: typeof resolveCliCommand } = {}
): StructuredAgentCommand {
  if (!hasExplicitTuiLaunchCommand(settings, agent)) {
    // WSL PATH may contain drive-mounted Windows shims after native entries.
    const command = stock.command ?? agent
    const resolved = resolveGuestNativeProgram(command, options, stock.resolve)
    if (resolved === null) {
      throw new AgentSessionPreSpawnError(
        `${command} is installed only on Windows, not in WSL ${process.env.WSL_DISTRO_NAME ?? 'distro'}`,
        { reason: 'cliMissing' }
      )
    }
    return { command: resolved, prefixArgs: [] }
  }
  const invocation = resolveOverride(agent, settings, options)
  if (!invocation || !spawnableOn(options.platform ?? process.platform, invocation.command)) {
    throw new AgentSessionPreSpawnError(`the ${agent} Command setting is not a runnable program`, {
      reason: 'agentCommandNotRunnable'
    })
  }
  return invocation
}

export type ProgramSearch<T> = {
  signal?: AbortSignal
  env: (resolved: T) => NodeJS.ProcessEnv | undefined
  cwd?: () => Promise<string> | string
}

/** Bare names may resolve only at spawn through a relative PATH entry under the launch cwd. */
async function foundNothing<T extends { command: string }>(
  resolved: T,
  search: ProgramSearch<T>,
  operation?: StructuredAgentResolutionOperation
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
  const from =
    (await waitForPromiseWithSignal(Promise.resolve(search.cwd?.()), search.signal)) ??
    process.cwd()
  assertStructuredAgentResolutionCurrent(operation)
  const found = resolveCliCommand(resolved.command, {
    pathEnv: relative.map((entry) => resolvePath(from, entry)).join(delimiter),
    homePath: env?.HOME ?? env?.USERPROFILE
  })
  return !isAbsolute(found)
}

/** On a miss, await a shell refresh started after this lookup and retry once; found programs never wait. */
export async function resolveAgainAfterRefreshOnMissingProgram<T extends { command: string }>(
  resolve: () => Promise<T>,
  refreshAfterMiss: ((askedAt: number) => Promise<void>) | undefined,
  search: ProgramSearch<T>,
  operation?: StructuredAgentResolutionOperation
): Promise<T> {
  assertStructuredAgentResolutionCurrent(operation)
  if (!refreshAfterMiss) {
    return waitForPromiseWithSignal(resolve(), search.signal)
  }
  const askedAt = Date.now()
  try {
    const resolved = await waitForPromiseWithSignal(resolve(), search.signal)
    assertStructuredAgentResolutionCurrent(operation)
    const missing = await foundNothing(resolved, search, operation)
    assertStructuredAgentResolutionCurrent(operation)
    if (!missing) {
      return resolved
    }
  } catch (error) {
    // cliMissing: only a Windows copy was found; a refreshed shell may now show a WSL install.
    if (
      !isAgentSessionPreSpawnError(error) ||
      (error.reason !== 'agentCommandNotRunnable' && error.reason !== 'cliMissing')
    ) {
      throw error
    }
  }
  assertStructuredAgentResolutionCurrent(operation)
  search.signal?.throwIfAborted()
  await waitForPromiseWithSignal(refreshAfterMiss(askedAt), search.signal)
  search.signal?.throwIfAborted()
  assertStructuredAgentResolutionCurrent(operation)
  return waitForPromiseWithSignal(resolve(), search.signal)
}
