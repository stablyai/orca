import { homedir, platform } from 'os'
import path from 'path'
import { stat } from 'fs/promises'

// Why: Ghostty honors XDG before native macOS paths; we replicate that precedence.
function xdgConfigDirs(home: string): string[] {
  if (process.env.XDG_CONFIG_HOME) {
    return [path.join(process.env.XDG_CONFIG_HOME, 'ghostty')]
  }
  return [path.join(home, '.config', 'ghostty')]
}

// Why: Check legacy `config` first, then modern `config.ghostty` per Ghostty docs.
function withFilenames(dirs: string[]): string[] {
  return dirs.flatMap((dir) => [path.join(dir, 'config'), path.join(dir, 'config.ghostty')])
}

export function getGhosttyConfigPaths(): string[] {
  const home = homedir()
  const plat = platform()

  switch (plat) {
    case 'darwin': {
      const dirs = xdgConfigDirs(home)
      // Why: Native macOS path is the final fallback after XDG candidates.
      dirs.push(path.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty'))
      return withFilenames(dirs)
    }
    case 'linux': {
      return withFilenames(xdgConfigDirs(home))
    }
    case 'win32': {
      const appData = process.env.APPDATA || home
      const base = path.win32.join(appData, 'ghostty')
      // Why: path.win32.join preserves backslashes even when tests run on macOS/Linux.
      return [path.win32.join(base, 'config'), path.win32.join(base, 'config.ghostty')]
    }
    default:
      return []
  }
}

export async function findGhosttyConfigPath(): Promise<string | null> {
  for (const p of getGhosttyConfigPaths()) {
    try {
      const s = await stat(p)
      if (s.isFile()) {
        return p
      }
    } catch {
      // ENOENT or permission error — continue probing other paths.
    }
  }
  return null
}
