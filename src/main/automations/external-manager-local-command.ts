import { runProcess } from '../../shared/child-process/run-process'

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
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    // Why: these probes run while loading Automations; a wedged PATH shim must
    // not keep the list IPC pending forever.
    await runLocalProviderCommand(finder, [command], {
      timeoutMs: LOCAL_COMMAND_LOOKUP_TIMEOUT_MS,
      timeoutMessage: `Command lookup timed out after ${LOCAL_COMMAND_LOOKUP_TIMEOUT_MS}ms.`
    })
    return true
  } catch {
    return false
  }
}

// Why: local automation mutations back UI actions; a wedged CLI must not keep
// create/edit/run/delete pending after Node signals a timeout.
export function runLocalAutomationCommand(command: string, args: string[]): Promise<void> {
  return runLocalProviderCommand(command, args, {
    timeoutMs: LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS,
    timeoutMessage: `Local automation command timed out after ${LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS}ms.`
  })
}
