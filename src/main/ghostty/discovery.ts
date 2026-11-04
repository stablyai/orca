import { homedir, platform } from 'node:os'
import path from 'node:path'
import { stat } from 'node:fs/promises'

// Ghostty gives XDG paths priority over native macOS paths.
function xdgConfigDirs(home: string): string[] {
  if (process.env.XDG_CONFIG_HOME) {
    return [path.posix.join(process.env.XDG_CONFIG_HOME, 'ghostty')]
  }
  return [path.posix.join(home, '.config', 'ghostty')]
}

// Load config.ghostty before legacy config; later files override earlier ones.
function withFilenames(dirs: string[]): string[] {
  return dirs.flatMap((dir) => [
    path.posix.join(dir, 'config.ghostty'),
    path.posix.join(dir, 'config')
  ])
}

export function getGhosttyConfigPaths(): string[] {
  const home = homedir()
  const plat = platform()

  switch (plat) {
    case 'darwin': {
      const dirs = xdgConfigDirs(home)
      dirs.push(path.posix.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty'))
      return withFilenames(dirs)
    }
    case 'linux': {
      return withFilenames(xdgConfigDirs(home))
    }
    case 'win32': {
      const appData = process.env.APPDATA || home
      const base = path.win32.join(appData, 'ghostty')
      return [path.win32.join(base, 'config.ghostty'), path.win32.join(base, 'config')]
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

export async function findGhosttyConfigPaths(): Promise<string[]> {
  const found: string[] = []
  for (const p of getGhosttyConfigPaths()) {
    try {
      const s = await stat(p)
      if (s.isFile()) {
        found.push(p)
      }
    } catch {
      // Unreadable candidates must not prevent probing the remaining locations.
    }
  }
  return found
}

export async function findGhosttyConfigPath(): Promise<string | null> {
  const paths = await findGhosttyConfigPaths()
  return paths[0] ?? null
}
