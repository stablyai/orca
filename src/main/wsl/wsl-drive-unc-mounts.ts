/**
 * Which `/mnt/<letter>` folders really are Windows drives in a distro. A distro can mount anything
 * there, so a UNC path converts only when the distro's own mountinfo shows that same drive folder.
 */
import { posix } from 'node:path'
import { runProcess } from '@orca/process-host'
import { buildPosixStdoutFence } from '../../shared/posix-stdout-fence'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { wslUncPathToLinux } from '../../shared/wsl-paths'
import {
  parseWindowsDriveMountInfo,
  type WindowsDriveMount
} from '../runtime/wsl-guest-drive-mountinfo'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { resolveWslExecutablePath } from './wsl-executable-path'

const READ_TIMEOUT_MS = 10_000

/** Read inside the distro: WSL denies Windows the UNC spelling of its drive folders. Null when unreadable. */
export async function readWslDistroDriveMounts(
  distro: string
): Promise<WindowsDriveMount[] | null> {
  const fence = buildPosixStdoutFence('cat /proc/self/mountinfo', 'WSL')
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['sh', '-c', fence.command]),
    env: { ...process.env, WSL_UTF8: '1' },
    cwd: resolveWslInteropSpawnCwd(),
    timeoutMs: READ_TIMEOUT_MS,
    maxOutputBytes: 1_048_576
  })
  const mountInfo = result.timedOut || result.code !== 0 ? null : fence.readStdout(result.stdout)
  return mountInfo === null ? null : parseWindowsDriveMountInfo(mountInfo)
}

/** True when the innermost mount holding `path`'s folder is the whole drive `windowsPath` names. */
export function wslUncPathIsWindowsDriveFolder(
  path: string,
  distro: string,
  windowsPath: string,
  mounts: readonly WindowsDriveMount[]
): boolean {
  const linux = wslUncPathToLinux(path, distro)
  if (!linux) {
    return false
  }
  const normalized = posix.normalize(linux.replace(/\\/g, '/')).replace(/(.)\/+$/, '$1')
  // Linux paths are case-sensitive: a real /mnt/C directory is not the /mnt/c drive mount.
  const mount = mounts
    .filter(
      ({ mountPoint }) => normalized === mountPoint || normalized.startsWith(`${mountPoint}/`)
    )
    .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0]
  if (!mount?.windowsRoot) {
    return false
  }
  const tail = normalized.slice(mount.mountPoint.length).replace(/^\/+/, '').split('/').join('\\')
  return (
    normalizeRuntimePathForComparison(`${mount.windowsRoot}${tail}`) ===
    normalizeRuntimePathForComparison(windowsPath)
  )
}
