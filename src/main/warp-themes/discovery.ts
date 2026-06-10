import { homedir, platform } from 'os'
import path from 'path'

export function getWarpThemeDirectories(): string[] {
  const home = homedir()
  const plat = platform()

  switch (plat) {
    case 'darwin':
      return [path.join(home, '.warp', 'themes')]
    case 'linux': {
      const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
      return [path.join(dataHome, 'warp-terminal', 'themes')]
    }
    case 'win32': {
      const appData = process.env.APPDATA || home
      return [path.win32.join(appData, 'warp', 'Warp', 'data', 'themes')]
    }
    case 'aix':
    case 'android':
    case 'cygwin':
    case 'freebsd':
    case 'haiku':
    case 'netbsd':
    case 'openbsd':
    case 'sunos':
      return []
  }
}
