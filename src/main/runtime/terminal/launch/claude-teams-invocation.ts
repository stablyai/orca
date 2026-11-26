import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { readLaunchPosition } from '../../../../shared/agent-launch/startup/launch-position'
import { structuredAgentCommandPlan } from '../../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import { launchCommandProvenance } from '../../../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/concurrency/abort-signal-reason'
import { stripWindowsPathQuotes } from '../../../../shared/shell/command-resolution/node-cli-command-resolution'
import {
  AgentInventoryDeadlineError,
  readLocalTerminalAgentProgram,
  withAgentInventoryDeadline
} from '../../../preflight/agent-command-detection'
import { isOrcaAgentRuntimePath } from '../../../managed-agent-cli/managed-agent-cli-path'
import { isExecutableFile } from '../../../ipc/command-path/command-path-directory'
import {
  readEnvCaseInsensitive,
  resolveCommandOnLocalPath
} from '../../../ipc/command-path/command-path-resolver'

type Caller = { env?: Record<string, string>; cwd?: string }
const pendingCallerClaudeLookups = new Map<string, Promise<string | null>>()

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
    const selection = await readLocalTerminalAgentProgram('claude', 'posix', false, signal)
    throwIfSignalAborted(signal)
    if ('path' in selection) {
      return selection.path
    }
    if (caller.env) {
      const command = await waitForPromiseWithSignal(
        resolveClaudeOnCallerPath(caller.env, caller.cwd ?? caller.env.PWD),
        signal
      )
      if (command) {
        return command
      }
    }
    if (selection.kind === 'unknown') {
      throw new AgentInventoryDeadlineError()
    }
    throw new Error('Your Claude installation could not be found.')
  })
}

function resolveClaudeOnCallerPath(
  env: Record<string, string>,
  cwd: string | undefined
): Promise<string | null> {
  const windows = process.platform === 'win32'
  const callerPath = windows
    ? (readEnvCaseInsensitive(env, 'PATH') ?? '')
    : (env.PATH ?? '/usr/bin:/bin')
  const path = callerPath
    .split(delimiter)
    .map((dir) => (windows ? stripWindowsPathQuotes(dir) : dir))
    .map((dir) => (cwd && isAbsolute(cwd) ? resolve(cwd, dir) : dir))
    .filter((dir) => isAbsolute(dir) && !isOrcaAgentRuntimePath(dir))
    .join(delimiter)
  const pathExt = windows ? readEnvCaseInsensitive(env, 'PATHEXT') : undefined
  const key = JSON.stringify([path, cwd, pathExt])
  let pending = pendingCallerClaudeLookups.get(key)
  if (!pending) {
    pending = resolveCommandOnLocalPath('claude', {
      env: { PATH: path, PATHEXT: pathExt },
      cwd,
      probeCandidate: async (candidate) => {
        if (isOrcaAgentRuntimePath(candidate) || !(await isExecutableFile(candidate, windows))) {
          return false
        }
        const target = await realpath(candidate).catch(() => undefined)
        return Boolean(target && !isOrcaAgentRuntimePath(target))
      }
    }).finally(() => {
      pendingCallerClaudeLookups.delete(key)
    })
    pendingCallerClaudeLookups.set(key, pending)
  }
  return pending
}
