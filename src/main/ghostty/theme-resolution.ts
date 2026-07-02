import { homedir, platform } from 'node:os'
import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { parseGhosttyConfig } from './parser'

// Why: theme files ship a few dozen short lines; anything larger is not a
// Ghostty theme and should not be read into the main process.
const MAX_THEME_BYTES = 262_144

// Why: only color-bearing keys may flow from a theme into the import — a theme
// file must not be able to smuggle font/window settings past the user's config.
const THEME_COLOR_KEYS = new Set([
  'palette',
  'background',
  'foreground',
  'cursor-color',
  'cursor-text',
  'selection-background',
  'selection-foreground',
  'bold-color',
  'split-divider-color'
])

function xdgThemeDirs(home: string): string[] {
  if (process.env.XDG_CONFIG_HOME) {
    return [path.posix.join(process.env.XDG_CONFIG_HOME, 'ghostty', 'themes')]
  }
  return [path.posix.join(home, '.config', 'ghostty', 'themes')]
}

// Why: mirrors Ghostty's lookup — user themes (XDG, then the native macOS dir)
// shadow the bundled themes shipped inside the Ghostty install.
export function getGhosttyThemeSearchDirs(): string[] {
  const home = homedir()
  switch (platform()) {
    case 'darwin': {
      const dirs = xdgThemeDirs(home)
      dirs.push(
        path.posix.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'themes'),
        '/Applications/Ghostty.app/Contents/Resources/ghostty/themes'
      )
      return dirs
    }
    case 'linux': {
      return [...xdgThemeDirs(home), '/usr/share/ghostty/themes', '/usr/local/share/ghostty/themes']
    }
    default:
      // Why: Ghostty has no Windows build, so there is nowhere to probe.
      return []
  }
}

export async function resolveGhosttyThemeColors(
  name: string
): Promise<Record<string, string | string[]> | null> {
  // Why: the theme name becomes a filename below — refuse separators and
  // traversal so a crafted config cannot read arbitrary files.
  if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
    return null
  }

  for (const dir of getGhosttyThemeSearchDirs()) {
    const themePath = path.posix.join(dir, name)
    let content: string
    try {
      const info = await stat(themePath)
      if (!info.isFile() || info.size > MAX_THEME_BYTES) {
        continue
      }
      content = await readFile(themePath, 'utf-8')
    } catch {
      // ENOENT or permission error — keep probing the remaining dirs.
      continue
    }

    const parsed = parseGhosttyConfig(content)
    const colors: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (THEME_COLOR_KEYS.has(key)) {
        colors[key] = value
      }
    }
    return colors
  }
  return null
}
