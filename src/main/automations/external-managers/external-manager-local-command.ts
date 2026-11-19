import { dirname } from 'node:path'
import { runProcess } from '@orca/process-host'
import { resolveCliCommandAsync } from '../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { resolvePathEnvKey } from '../../pty/environment/windows-path-segment-merge'

const LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS = 30_000

// Why: CLIs resolved outside the inherited PATH (nvm-style) need their dir for shebang and .cmd interpreter lookup.
function withProgramDirectoryOnPath(program: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = resolvePathEnvKey(env, process.platform)
  const pathDelimiter = process.platform === 'win32' ? ';' : ':'
  const programDirectory = dirname(program)
  const isProgramDirectory = (entry: string): boolean =>
    process.platform === 'win32'
      ? entry.toLowerCase() === programDirectory.toLowerCase()
      : entry === programDirectory
  const inheritedEntries = (env[pathKey] ?? '')
    .split(pathDelimiter)
    // Empty entries are meaningful on POSIX (current directory), so keep them.
    .filter((entry) => !isProgramDirectory(entry))
  env[pathKey] = [programDirectory, ...inheritedEntries].join(pathDelimiter)
  return env
}

async function runLocalProviderCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; timeoutMessage: string }
): Promise<void> {
  // Unresolved names come back unchanged, so a missing CLI still fails as a spawn error.
  const program = await resolveCliCommandAsync(command)
  const result = await runProcess({
    program,
    args,
    timeoutMs: options.timeoutMs,
    // Unchanged resolution keeps the inherited env so existing behavior is preserved.
    ...(program === command ? {} : { env: withProgramDirectoryOnPath(program) })
  })
  if (result.timedOut) {
    throw new Error(options.timeoutMessage)
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Command exited with code ${result.code ?? 'unknown'}.`)
  }
}

export async function isExternalAutomationCommandOnPath(command: string): Promise<boolean> {
  try {
    // A relative PATH entry can normalize a hit back to the bare name, so string inequality
    // alone would miss it; the path resolver returns null only for a real miss.
    return (
      (await resolveCliCommandAsync(command)) !== command ||
      (await resolveCommandOnLocalPath(command)) !== null
    )
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
