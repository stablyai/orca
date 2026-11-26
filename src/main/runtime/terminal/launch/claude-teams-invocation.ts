import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { readLaunchPosition } from '../../../../shared/agent-launch/startup/launch-position'
import { structuredAgentCommandPlan } from '../../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import { launchCommandProvenance } from '../../../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  AgentInventoryDeadlineError,
  readLocalTerminalAgentProgram
} from '../../../preflight/agent-command-detection'
import { isOrcaAgentRuntimePath } from '../../../managed-agent-cli/managed-agent-cli-path'
import { isExecutableFile } from '../../../ipc/command-path/command-path-directory'
import { resolveCommandOnLocalPath } from '../../../ipc/command-path/command-path-resolver'

type Caller = { env?: Record<string, string>; cwd?: string }

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
  const selection = await readLocalTerminalAgentProgram('claude', 'posix')
  if ('path' in selection) {
    return selection.path
  }
  if (caller.env) {
    const cwd = caller.cwd ?? caller.env.PWD
    const directories = (caller.env.PATH ?? '/usr/bin:/bin').split(delimiter)
    const path = directories
      .map((dir) => (cwd && isAbsolute(cwd) ? resolve(cwd, dir) : dir))
      .filter((dir) => isAbsolute(dir) && !isOrcaAgentRuntimePath(dir))
      .join(delimiter)
    const command = await resolveCommandOnLocalPath('claude', {
      env: { ...caller.env, PATH: path },
      cwd,
      probeCandidate: async (candidate) => {
        const target = await realpath(candidate).catch(() => undefined)
        return Boolean(
          target && !isOrcaAgentRuntimePath(target) && (await isExecutableFile(candidate, false))
        )
      }
    })
    if (command) {
      return command
    }
  }
  if (selection.kind === 'unknown') {
    throw new AgentInventoryDeadlineError()
  }
  throw new Error('Your Claude installation could not be found.')
}
