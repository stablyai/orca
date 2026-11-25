import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { getSpawnArgsForWindows } from '../../shared/shell/launch/windows-batch-spawn'

// Why: az is a Python CLI — cold starts routinely exceed the API request timeout.
const AZ_TIMEOUT_MS = 20_000

/** Run `az account get-access-token` for an Entra resource; returns raw stdout JSON. */
export async function runAzAccessTokenCommand(resource: string): Promise<string> {
  const args = ['account', 'get-access-token', '--resource', resource, '--output', 'json']
  // Why: Windows ships az as a .cmd shim, which only runs through cmd.exe without a shell.
  const az = process.platform === 'win32' ? ((await resolveCommandOnLocalPath('az')) ?? 'az') : 'az'
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(az, args)
  const { code, stdout, stderr, timedOut } = await runProcess({
    program: spawnCmd,
    args: spawnArgs,
    timeoutMs: AZ_TIMEOUT_MS
  })
  // Why: runProcess reports failure in the result; callers cache on a thrown error.
  if (timedOut || code !== 0) {
    const reason = timedOut ? 'timed out' : `exited ${code}`
    throw new Error(
      `az account get-access-token ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`
    )
  }
  return stdout
}
