import { homedir, platform } from 'os'
import path from 'path'
import { stat } from 'fs/promises'

// Why: Ghostty honors XDG before native macOS paths; we replicate that precedence.
function xdgConfigDirs(home: string): string[] {
  if (process.env.XDG_CONFIG_HOME) {
    return [path.posix.join(process.env.XDG_CONFIG_HOME, 'ghostty')]
  }
  return [path.posix.join(home, '.config', 'ghostty')]
}

// Why: Ghostty loads the modern filename before the legacy `config` fallback,
// and later files in this order override earlier files.
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
      // Why: Native macOS path is the final fallback after XDG candidates.
      dirs.push(path.posix.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty'))
      return withFilenames(dirs)
    }
    case 'linux': {
      return withFilenames(xdgConfigDirs(home))
    }
    case 'win32': {
      const appData = process.env.APPDATA || home
      const base = path.win32.join(appData, 'ghostty')
      // Why: path.win32.join preserves backslashes even when tests run on macOS/Linux.
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
      // ENOENT or permission error — continue probing other paths.
    }
  }
  return found
}

export async function findGhosttyConfigPath(): Promise<string | null> {
  const paths = await findGhosttyConfigPaths()
  return paths[0] ?? null
}
