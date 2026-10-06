import { join, posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath, toLinuxPath, toWindowsWslUncPath } from '../../shared/wsl-paths'

/** The guest's own `~/.codex` for a distro, from the home `getWslHome` reported. */
export function resolveWslGuestCodexHomePath(guestHome: string, distro: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(guestHome)) {
    const linuxHome = toLinuxPath(guestHome).trim()
    return linuxHome.startsWith('/')
      ? toWindowsWslUncPath(pathPosix.join(linuxHome, '.codex'), distro)
      : null
  }
  return parseWslUncPath(guestHome)
    ? pathWin32.join(guestHome, '.codex')
    : join(guestHome, '.codex')
}
