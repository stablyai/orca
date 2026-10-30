import { runProcess } from '@orca/process-host'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { resolveWslExecutablePath } from './wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

const BOOT_ID_TIMEOUT_MS = 5_000
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The distro kernel's boot id, which changes each time the distro starts. `wsl.exe --exec` boots a
 * stopped distro, so callers must have just confirmed it runs. Null when it can't be read.
 */
export async function readWslDistroBootId(distro: string): Promise<string | null> {
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    // --exec with no shell: no rc files, so stdout is the file alone.
    args: buildWslExecArgs(distro, ['cat', '/proc/sys/kernel/random/boot_id']),
    env: { ...process.env, WSL_UTF8: '1' },
    cwd: resolveWslInteropSpawnCwd(),
    timeoutMs: BOOT_ID_TIMEOUT_MS,
    maxOutputBytes: 256
  })
  if (result.timedOut || result.code !== 0) {
    return null
  }
  const bootId = result.stdout.trim()
  return BOOT_ID.test(bootId) ? bootId.toLowerCase() : null
}
