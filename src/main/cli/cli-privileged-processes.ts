import { runProcess } from '../../shared/child-process/run-process'
import { WINDOWS_PATH_WRITE_TIMEOUT_MS } from './cli-install-constants'

export async function runMacPrivilegedCommand(command: string): Promise<void> {
  const result = await runProcess({
    program: 'osascript',
    args: ['-e', `do shell script ${quoteAppleScript(command)} with administrator privileges`],
    // Why: the OS authorization prompt is user-paced and previously had no deadline.
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw processFailure('osascript', result)
  }
}

function quoteAppleScript(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export async function writeWindowsUserPath(value: string): Promise<void> {
  await runWindowsPathCommand([
    '-NoProfile',
    '-Command',
    `[Environment]::SetEnvironmentVariable('Path', ${quotePowerShell(value)}, 'User')`
  ])
}

export async function runWindowsPathCommand(args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'powershell',
    args,
    timeoutMs: WINDOWS_PATH_WRITE_TIMEOUT_MS
  })
  if (result.timedOut) {
    throw new Error(`Windows PATH command timed out after ${WINDOWS_PATH_WRITE_TIMEOUT_MS}ms.`)
  }
  if (result.code !== 0) {
    throw processFailure('powershell', result)
  }
  return result.stdout
}

function processFailure(
  program: string,
  result: { code: number | null; stderr: string; stdout: string }
): Error {
  const detail = result.stderr || result.stdout
  const error = new Error(detail || `${program} exited with code ${result.code ?? 'unknown'}`)
  Object.assign(error, { code: result.code, stderr: result.stderr })
  return error
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
