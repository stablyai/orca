import { readFile, realpath } from 'node:fs/promises'
import { posix } from 'node:path'
import { WslHostWindowsDriveRefusalError } from '../../shared/wsl-host-windows-drive-refusal'
import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'
import { parseWindowsDriveMountInfo, type WindowsDriveMount } from './wsl-guest-drive-mountinfo'

export type WslHostWindowsDriveGuardDeps = {
  isWslHost: () => boolean
  readMounts: () => Promise<readonly WindowsDriveMount[]>
  realpath: (path: string) => Promise<string>
}

const defaultDeps: WslHostWindowsDriveGuardDeps = {
  isWslHost: () => isWslHostOrcadProcess(),
  // Read per check (project adds only), so a drive mounted after orcad started is still caught.
  readMounts: async () =>
    parseWindowsDriveMountInfo(await readFile('/proc/self/mountinfo', 'utf8').catch(() => '')),
  realpath: (path) => realpath(path)
}

/** WSL-host orcad only: refuse a project on a Windows drive mount, including through a symlink. SSH hosts never set the WSL-host marker. */
export async function refuseWslHostWindowsDrivePath(
  path: string,
  deps: WslHostWindowsDriveGuardDeps = defaultDeps
): Promise<void> {
  if (!deps.isWslHost()) {
    return
  }
  const mounts = await deps.readMounts()
  if (mounts.length === 0) {
    return
  }
  // A missing path cannot resolve; its spelling is still checked.
  const resolved = await deps.realpath(path).catch(() => null)
  for (const candidate of resolved ? [path, resolved] : [path]) {
    const normalized = posix.normalize(candidate).replace(/(.)\/+$/, '$1')
    // The innermost mount owns the path.
    const mount = mounts
      .filter(
        (entry) => normalized === entry.mountPoint || normalized.startsWith(`${entry.mountPoint}/`)
      )
      .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0]
    if (mount) {
      throw new WslHostWindowsDriveRefusalError(windowsPathFor(normalized, mount))
    }
  }
}

function windowsPathFor(linuxPath: string, mount: WindowsDriveMount): string | null {
  if (!mount.windowsRoot) {
    return null
  }
  const tail = linuxPath.slice(mount.mountPoint.length).replace(/^\/+/, '')
  return `${mount.windowsRoot}${tail.split('/').join('\\')}`
}
