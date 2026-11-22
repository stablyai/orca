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

function userThemeDirs(home: string, plat: NodeJS.Platform): string[] {
  // Ghostty's XDG config lookup falls back to LOCALAPPDATA on Windows.
  if (plat === 'win32') {
    const configHome = process.env.XDG_CONFIG_HOME || process.env.LOCALAPPDATA || home
    return [path.win32.join(configHome, 'ghostty', 'themes')]
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.posix.join(home, '.config')
  return [path.posix.join(configHome, 'ghostty', 'themes')]
}

// Keeps lookups testable for every platform regardless of the host running the tests.
function pathFor(plat: NodeJS.Platform): path.PlatformPath {
  return plat === 'win32' ? path.win32 : path.posix
}

// Ghostty finds resources next to its executable; probe the install locations that layout produces.
function resourceThemeDirs(home: string, plat: NodeJS.Platform): string[] {
  if (process.env.GHOSTTY_RESOURCES_DIR) {
    return [pathFor(plat).join(process.env.GHOSTTY_RESOURCES_DIR, 'themes')]
  }
  if (plat === 'darwin') {
    const bundled = path.posix.join('Ghostty.app', 'Contents', 'Resources', 'ghostty', 'themes')
    return [
      path.posix.join('/Applications', bundled),
      path.posix.join(home, 'Applications', bundled)
    ]
  }
  if (plat === 'linux') {
    const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
      .split(':')
      .filter((dir) => path.posix.isAbsolute(dir))
    const prefixes = [
      ...dataDirs,
      path.posix.join(home, '.local', 'share'),
      '/snap/ghostty/current/share'
    ]
    return [...new Set(prefixes)].map((dir) => path.posix.join(dir, 'ghostty', 'themes'))
  }
  return []
}

// User themes shadow bundled themes, matching Ghostty lookup order; a picked config's sibling themes dir only fills gaps.
export function getGhosttyThemeSearchDirs(pickedConfigDir?: string): string[] {
  const home = homedir()
  const plat = platform()
  return [
    ...userThemeDirs(home, plat),
    ...(pickedConfigDir ? [pathFor(plat).join(pickedConfigDir, 'themes')] : []),
    ...resourceThemeDirs(home, plat)
  ]
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

export async function resolveGhosttyThemeColors(
  rawName: string,
  pickedConfigDir?: string
): Promise<ThemeColors | null> {
  const paths = pathFor(platform())
  // Ghostty expands a leading `~/` before deciding whether a theme value is absolute.
  const name = rawName.startsWith('~/') ? paths.join(homedir(), rawName.slice(2)) : rawName
  if (paths.isAbsolute(name)) {
    const result = await readThemeColors(name)
    return result.status === 'found' ? result.colors : null
  }

  // Relative theme names cannot contain path separators; absolute paths remain supported.
  if (!isRelativeThemeName(name)) {
    return null
  }

  for (const dir of getGhosttyThemeSearchDirs(pickedConfigDir)) {
    const result = await readThemeColors(paths.join(dir, name))
    if (result.status === 'found') {
      return result.colors
    }
    if (result.status === 'invalid') {
      return null
    }
  }
  return null
}
