import { homedir, platform } from 'node:os'
import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { parseGhosttyConfig } from './parser'

// Bound theme reads to keep large or misidentified files out of main-process memory.
const MAX_THEME_BYTES = 262_144
type ThemeColors = Record<string, string | string[]>
type ThemeReadResult =
  | { status: 'found'; colors: ThemeColors }
  | { status: 'missing' }
  | { status: 'invalid' }

// Themes may supply colors only; font and window settings must come from explicit config.
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

function resourceThemeDirs(plat: 'darwin' | 'linux'): string[] {
  if (process.env.GHOSTTY_RESOURCES_DIR) {
    return [path.posix.join(process.env.GHOSTTY_RESOURCES_DIR, 'themes')]
  }

  if (plat === 'darwin') {
    return ['/Applications/Ghostty.app/Contents/Resources/ghostty/themes']
  }
  return ['/usr/share/ghostty/themes', '/usr/local/share/ghostty/themes']
}

// User themes shadow bundled themes, matching Ghostty lookup order.
export function getGhosttyThemeSearchDirs(): string[] {
  const home = homedir()
  const plat = platform()
  if (plat !== 'darwin' && plat !== 'linux') {
    return []
  }
  return [...xdgThemeDirs(home), ...resourceThemeDirs(plat)]
}

function isMissingThemeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false
  }
  const code = (err as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isRelativeThemeName(name: string): boolean {
  return !name.includes('/') && !name.includes('\\') && name !== '..' && name !== '.'
}

function themeColorsFromContent(content: string): ThemeColors {
  const parsed = parseGhosttyConfig(content)
  const colors: ThemeColors = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (THEME_COLOR_KEYS.has(key)) {
      colors[key] = value
    }
  }
  return colors
}

async function readThemeColors(themePath: string): Promise<ThemeReadResult> {
  let content: string
  try {
    const info = await stat(themePath)
    if (!info.isFile() || info.size > MAX_THEME_BYTES) {
      return { status: 'invalid' }
    }
    content = await readFile(themePath, 'utf-8')
  } catch (err) {
    return { status: isMissingThemeError(err) ? 'missing' : 'invalid' }
  }

  return { status: 'found', colors: themeColorsFromContent(content) }
}

export async function resolveGhosttyThemeColors(name: string): Promise<ThemeColors | null> {
  if (path.isAbsolute(name)) {
    const result = await readThemeColors(name)
    return result.status === 'found' ? result.colors : null
  }

  // Relative theme names cannot contain path separators; absolute paths remain supported.
  if (!isRelativeThemeName(name)) {
    return null
  }

  for (const dir of getGhosttyThemeSearchDirs()) {
    const themePath = path.posix.join(dir, name)
    const result = await readThemeColors(themePath)
    if (result.status === 'found') {
      return result.colors
    }
    if (result.status === 'invalid') {
      return null
    }
  }
  return null
}
