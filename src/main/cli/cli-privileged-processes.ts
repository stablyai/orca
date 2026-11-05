import { runProcess } from '@orca/process-host'
import { quotePowerShellLiteral } from '../../shared/powershell-native-argument'
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
    `[Environment]::SetEnvironmentVariable('Path', ${quotePowerShellLiteral(value)}, 'User')`
  ])
}

// Private on purpose: its timeout retry is only safe for the idempotent PATH write above.
async function runWindowsPathCommand(args: string[]): Promise<string> {
  const run = () =>
    runProcess({ program: 'powershell', args, timeoutMs: WINDOWS_PATH_WRITE_TIMEOUT_MS })
  let result = await run()
  // Setting PATH to a fixed value is idempotent, so one retry is safe even if the first landed.
  if (result.timedOut) {
    result = await run()
  }
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
