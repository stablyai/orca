import { runProcess } from '@orca/process-host'
import { resolveCliCommandAsync } from '../../../shared/shell/command-resolution/node-cli-command-async-resolution'

const LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS = 30_000

async function runLocalProviderCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; timeoutMessage: string }
): Promise<void> {
  // Unresolved names come back unchanged, so a missing CLI still fails as a spawn error.
  const program = await resolveCliCommandAsync(command)
  const result = await runProcess({ program, args, timeoutMs: options.timeoutMs })
  if (result.timedOut) {
    throw new Error(options.timeoutMessage)
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Command exited with code ${result.code ?? 'unknown'}.`)
  }
}

export async function isExternalAutomationCommandOnPath(command: string): Promise<boolean> {
  try {
    return (await resolveCliCommandAsync(command)) !== command
  } catch {
    return false
  }
}

export function runLocalAutomationCommand(command: string, args: string[]): Promise<void> {
  return runLocalProviderCommand(command, args, {
    timeoutMs: LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS,
    timeoutMessage: `Local automation command timed out after ${LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS}ms.`
  })
}
