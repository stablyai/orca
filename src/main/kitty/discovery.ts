import { homedir, platform } from 'node:os'
import path from 'node:path'
import { stat } from 'node:fs/promises'

function expandHome(dir: string, home: string): string {
  return dir === '~' || dir.startsWith('~/') ? path.posix.join(home, dir.slice(1)) : dir
}

// Kitty's ConfigDirForName order; Kitty has no Windows build, so only an explicit directory applies there.
export function getKittyConfigPaths(): string[] {
  const home = homedir()
  const explicitDir = process.env.KITTY_CONFIG_DIRECTORY
  if (explicitDir) {
    return [path.join(expandHome(explicitDir, home), 'kitty.conf')]
  }
  const plat = platform()
  if (plat === 'win32') {
    return []
  }
  const roots = [
    process.env.XDG_CONFIG_HOME,
    ...(process.env.XDG_CONFIG_DIRS ?? '').split(':'),
    '~/.config',
    ...(plat === 'darwin' ? ['~/Library/Preferences'] : [])
  ]
  const dirs = roots
    .filter((root): root is string => Boolean(root))
    .map((root) => path.posix.join(expandHome(root, home), 'kitty'))
  return [...new Set(dirs)].map((dir) => path.posix.join(dir, 'kitty.conf'))
}

/** Kitty reads a single kitty.conf: the first location that has one. */
export async function findKittyConfigPaths(): Promise<string[]> {
  for (const configPath of getKittyConfigPaths()) {
    try {
      if ((await stat(configPath)).isFile()) {
        return [configPath]
      }
    } catch {
      // Unreadable candidates must not prevent probing the remaining locations.
    }
  }
  return []
}
