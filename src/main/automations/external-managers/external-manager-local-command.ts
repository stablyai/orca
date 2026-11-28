import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { getSystem32ExePath } from '../../windows/windows-command-paths'

const LOCAL_COMMAND_LOOKUP_TIMEOUT_MS = 5_000
const LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS = 30_000

function runLocalProviderCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; timeoutMessage: string }
): Promise<void> {
  return runProcess({ program: command, args, timeoutMs: options.timeoutMs }).then((result) => {
    if (result.timedOut) {
      throw new Error(options.timeoutMessage)
    }
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `Command exited with code ${result.code ?? 'unknown'}.`
      )
    }
  })
}

export async function isExternalAutomationCommandOnPath(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? getSystem32ExePath('where.exe') : 'which'
  try {
    await runLocalProviderCommand(finder, [command], {
      timeoutMs: LOCAL_COMMAND_LOOKUP_TIMEOUT_MS,
      timeoutMessage: `Command lookup timed out after ${LOCAL_COMMAND_LOOKUP_TIMEOUT_MS}ms.`
    })
    return true
  } catch {
    return false
  }
}

export async function runLocalAutomationCommand(command: string, args: string[]): Promise<void> {
  // Windows npm shims are .cmd files that a bare name cannot spawn.
  const program =
    process.platform === 'win32' ? ((await resolveCommandOnLocalPath(command)) ?? command) : command
  return runLocalProviderCommand(program, args, {
    timeoutMs: LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS,
    timeoutMessage: `Local automation command timed out after ${LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS}ms.`
  })
}
