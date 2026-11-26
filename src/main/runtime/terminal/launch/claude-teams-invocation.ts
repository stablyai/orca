import { homedir } from 'node:os'
import { join } from 'node:path'
import { readLaunchPosition } from '../../../../shared/agent-launch/startup/launch-position'
import { structuredAgentCommandPlan } from '../../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import { launchCommandProvenance } from '../../../../shared/agent-launch/startup/managed-agent-launch-program'
import { readLocalTerminalAgentProgram } from '../../../preflight/agent-command-detection'
import { isOrcaAgentRuntimePath } from '../../../managed-agent-cli/managed-agent-cli-path'

export async function resolveClaudeTeamsInvocation(override: string | undefined): Promise<{
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
    return { command: command === 'claude' ? await userClaude() : command, args: plan.prefixArgs }
  }
  return { command: await userClaude() }
}

async function userClaude(): Promise<string> {
  const selection = await readLocalTerminalAgentProgram('claude', 'posix')
  if (!('path' in selection)) {
    throw new Error('Your Claude installation could not be found.')
  }
  return selection.path
}
