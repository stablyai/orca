import { dirname } from 'node:path'
import { runProcess } from '@orca/process-host'
import { resolveCliCommandAsync } from '../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { pathEnvRelativeTo } from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import { resolvePathEnvKey } from '../../pty/environment/windows-path-segment-merge'

const LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS = 30_000

function resolveLocalCommand(command: string): Promise<string> {
  const pathKey = resolvePathEnvKey(process.env, process.platform)
  return resolveCliCommandAsync(command, {
    pathEnv: pathEnvRelativeTo(process.env[pathKey], process.cwd())
  })
}

// Why: CLIs resolved outside the inherited PATH (nvm-style) need their dir for shebang and .cmd interpreter lookup.
function withProgramDirectoryOnPath(program: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = resolvePathEnvKey(env, process.platform)
  const pathDelimiter = process.platform === 'win32' ? ';' : ':'
  const programDirectory = dirname(program)
  const pathEntryKey = (entry: string): string =>
    process.platform === 'win32' ? entry.replace(/[\\/]+$/, '').toLowerCase() : entry
  const programDirectoryKey = pathEntryKey(programDirectory)
  const inheritedPath = env[pathKey]
  if (inheritedPath === undefined) {
    env[pathKey] = programDirectory
    return env
  }
  // Keep empty entries (POSIX current directory) and inherited order: prepending the CLI dir
  // could select a sibling `node` ahead of the one the inherited PATH would have used.
  const inheritedEntries = inheritedPath.split(pathDelimiter)
  if (inheritedEntries.some((entry) => pathEntryKey(entry) === programDirectoryKey)) {
    return env
  }
  env[pathKey] = [...inheritedEntries, programDirectory].join(pathDelimiter)
  return env
}

async function runLocalProviderCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; timeoutMessage: string }
): Promise<void> {
  // Fall back to the local-path resolver so a Windows .cmd/.bat shim the availability check
  // accepts is spawned by its real path instead of a bare name that cannot match the shim.
  const cliProgram = await resolveLocalCommand(command)
  const program =
    cliProgram === command ? ((await resolveCommandOnLocalPath(command)) ?? command) : cliProgram
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
      (await resolveLocalCommand(command)) !== command ||
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
