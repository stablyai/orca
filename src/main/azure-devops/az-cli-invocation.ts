import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSpawnArgsForWindows, resolveWindowsCommand } from '../win32-utils'

const execFileAsync = promisify(execFile)

// Why: az is a Python CLI — cold starts routinely exceed the API request timeout.
const AZ_TIMEOUT_MS = 20_000

/** Run `az account get-access-token` for an Entra resource; returns raw stdout JSON. */
export async function runAzAccessTokenCommand(resource: string): Promise<string> {
  const command = resolveWindowsCommand('az')
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, [
    'account',
    'get-access-token',
    '--resource',
    resource,
    '--output',
    'json'
  ])
  const { stdout } = await execFileAsync(spawnCmd, spawnArgs, {
    timeout: AZ_TIMEOUT_MS,
    encoding: 'utf-8',
    windowsHide: true
  })
  return stdout
}
