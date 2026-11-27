import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { readLaunchPosition } from '../../../../shared/agent-launch/startup/launch-position'
import { structuredAgentCommandPlan } from '../../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import { launchCommandProvenance } from '../../../../shared/agent-launch/startup/managed-agent-launch-program'
import { abortSignalReason } from '../../../../shared/concurrency/abort-signal-reason'
import { PromiseSettlementWaiters } from '../../../../shared/concurrency/promise-settlement-waiters'
import { stripWindowsPathQuotes } from '../../../../shared/shell/command-resolution/node-cli-command-resolution'
import {
  AgentInventoryDeadlineError,
  readLocalTerminalAgentProgram,
  type TerminalAgentProgram,
  withAgentInventoryDeadline
} from '../../../preflight/agent-command-detection'
import {
  canonicalLocalAgentProgram,
  isOrcaAgentRuntimePath
} from '../../../managed-agent-cli/managed-agent-cli-path'
import {
  readEnvCaseInsensitive,
  resolveCommandOnLocalPath
} from '../../../ipc/command-path/command-path-resolver'

type Caller = { env?: Record<string, string>; cwd?: string }
const pendingCallerClaudeLookups = new Map<string, PromiseSettlementWaiters<string | null>>()
const windowsDirectExecutable = /\.(exe|com)$/i

export async function resolveClaudeTeamsInvocation(
  override: string | undefined,
  caller: Caller = {}
): Promise<{
  command: string
  args?: string[]
}> {
  if (override && launchCommandProvenance(override, 'claude', process.platform) === 'authored') {
    const text = override.trim()
    const head = readLaunchPosition(text, 'posix')
    const plan = structuredAgentCommandPlan(text, process.platform)
    if (!head || head.start !== 0 || !plan || plan.prefixArgs.some((arg) => arg.startsWith('~/'))) {
      throw new Error(
        'This Claude Command requires a shell. Start Agent Teams from the terminal picker to use it.'
      )
    }
    const command = text.startsWith('~/')
      ? join(homedir(), head.executable.slice(2))
      : head.executable
    if (isOrcaAgentRuntimePath(command)) {
      throw new Error('Agent Teams requires your own Claude installation.')
    }
    return {
      command: command === 'claude' ? await userClaude(caller) : command,
      args: plan.prefixArgs
    }
  }
  return { command: await userClaude(caller) }
}

async function userClaude(caller: Caller): Promise<string> {
  return withAgentInventoryDeadline(async (signal) => {
    const selection = caller.env
      ? undefined
      : await readLocalTerminalAgentProgram('claude', 'posix', false, signal)
    const command = caller.env
      ? await resolveClaudeOnCallerPath(caller.env, caller.cwd ?? caller.env.PWD, signal).catch(
          () => null
        )
      : selection && directClaudePath(selection)
    if (command) {
      return command
    }
    if (signal.aborted || selection?.kind === 'unknown') {
      throw new AgentInventoryDeadlineError()
    }
    throw new Error('Your Claude installation could not be found.')
  })
}

function directClaudePath(selection: TerminalAgentProgram): string | undefined {
  if (
    'path' in selection &&
    (process.platform !== 'win32' || windowsDirectExecutable.test(selection.path))
  ) {
    return selection.path
  }
  return undefined
}

function resolveClaudeOnCallerPath(
  env: Record<string, string>,
  cwd: string | undefined,
  signal: AbortSignal
): Promise<string | null> {
  const windows = process.platform === 'win32'
  const callerPath = windows
    ? (readEnvCaseInsensitive(env, 'PATH') ?? '')
    : (env.PATH ?? '/usr/bin:/bin')
  const callerDirectory = cwd && isAbsolute(cwd) ? cwd : undefined
  const path = callerPath
    .split(delimiter)
    .map((dir) => (windows ? stripWindowsPathQuotes(dir) : dir))
    .map((dir) => (callerDirectory || isAbsolute(dir) ? resolve(callerDirectory ?? '', dir) : dir))
    .filter((dir) => isAbsolute(dir) && !isOrcaAgentRuntimePath(dir))
    .join(delimiter)
  const pathExt = windows ? readEnvCaseInsensitive(env, 'PATHEXT') : undefined
  // Windows also searches cwd before PATH; POSIX relative entries already include it.
  const lookupDirectory = windows ? (callerDirectory ?? '') : ''
  const key = JSON.stringify([path, pathExt, lookupDirectory])
  let pending = pendingCallerClaudeLookups.get(key)
  if (!pending) {
    const controller = new AbortController()
    const lookup = new PromiseSettlementWaiters<string | null>(
      Promise.resolve().then(() => {
        if (lookup.waiterCount === 0) {
          return null
        }
        return resolveCommandOnLocalPath('claude', {
          env: { PATH: path, PATHEXT: pathExt },
          cwd: lookupDirectory,
          signal: controller.signal,
          probeCandidate: async (candidate) => {
            if (
              (windows && !windowsDirectExecutable.test(candidate)) ||
              isOrcaAgentRuntimePath(candidate)
            ) {
              return false
            }
            try {
              return Boolean(await canonicalLocalAgentProgram(candidate, controller.signal))
            } finally {
              // Let a new waiter join an issued probe, then stop before admitting another.
              if (lookup.waiterCount === 0) {
                controller.abort()
              }
            }
          }
        })
      }),
      () => pendingCallerClaudeLookups.delete(key)
    )
    pending = lookup
    pendingCallerClaudeLookups.set(key, pending)
  }
  return pending.wait({ signal, createAbortError: () => abortSignalReason(signal) })
}
