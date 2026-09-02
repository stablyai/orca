import { runProcess } from '../../shared/child-process/run-process'
import { resolveWindowsCommand } from '../win32-utils'

// Why: az is a Python CLI — cold starts routinely exceed the API request timeout.
const AZ_TIMEOUT_MS = 20_000

/** Run `az account get-access-token` for an Entra resource; returns raw stdout JSON. */
export async function runAzAccessTokenCommand(resource: string): Promise<string> {
  const { code, stdout, stderr, timedOut } = await runProcess({
    // Why: runProcess spawns without a shell, so Windows needs the resolved
    // path — `az` ships as a .cmd shim that bare-name spawning cannot find.
    program: resolveWindowsCommand('az'),
    args: ['account', 'get-access-token', '--resource', resource, '--output', 'json'],
    timeoutMs: AZ_TIMEOUT_MS
  })
  // Why: runProcess reports failure in the result; callers cache on a thrown error.
  if (timedOut || code !== 0) {
    const reason = timedOut ? 'timed out' : `exited ${code}`
    throw new Error(`az account get-access-token ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
  }
  return stdout
}
