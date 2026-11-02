import path from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type {
  TerminalColorOverrides,
  TerminalThemeSlot
} from '../../shared/terminal-color-overrides'
import {
  inferTerminalThemeMode,
  makeCustomTerminalThemeSelection,
  MAX_TERMINAL_CUSTOM_THEMES,
  normalizeTerminalColorOverrides,
  normalizeTerminalCustomThemes,
  normalizeTerminalThemeId,
  normalizeTerminalThemeName,
  type TerminalCustomTheme
} from '../../shared/terminal-custom-themes'
import { DEFAULT_TERMINAL_THEME_DARK } from '../../shared/terminal-theme-selection'
import { TERMINAL_THEME_CATALOG } from '../../shared/terminal-themes'
import { mapGhosttyToOrca } from './mapper'
import { resolveGhosttyThemeColors } from './theme-resolution'

export type GhosttyThemePair = { light: string; dark: string }

export type GhosttyThemeImport = {
  /** Theme selection keys plus the full custom theme list when a theme file was imported. */
  diff: Partial<GlobalSettings>
  /** Display name per slot whose palette this import now defines. */
  themeNames: Partial<Record<TerminalThemeSlot, string>>
  unsupportedKeys: string[]
}

const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/

// Mirrors Ghostty's Theme.parseCLI: a comma, colon or `=` marks a light/dark pair, and both halves are required.
export function parseGhosttyThemeValue(value: string): GhosttyThemePair | null {
  const trimmed = value.trim()
  if (!/[,:=]/.test(trimmed) || WINDOWS_DRIVE_PATH_RE.test(trimmed)) {
    return trimmed ? { light: trimmed, dark: trimmed } : null
  }
  const pair: Partial<GhosttyThemePair> = {}
  for (const part of trimmed.split(',')) {
    const separator = part.search(/[:=]/)
    const slot = part.slice(0, Math.max(separator, 0)).trim()
    const name = part.slice(separator + 1).trim()
    if (separator === -1 || (slot !== 'light' && slot !== 'dark') || !name) {
      return null
    }
    pair[slot] = name
  }
  return pair.light && pair.dark ? { light: pair.light, dark: pair.dark } : null
}

function normalizeCatalogName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.conf$/, '')
    .replace(/[-_\s]+/g, ' ')
    .trim()
}

let catalogNamesByKey: Map<string, string> | null = null

// Without a Ghostty install (Windows, or a config copied from another machine) Orca's own catalog is the only theme set left.
function findBuiltInThemeName(name: string): string | null {
  catalogNamesByKey ??= new Map(
    Object.keys(TERMINAL_THEME_CATALOG).map((catalogName) => [
      normalizeCatalogName(catalogName),
      catalogName
    ])
  )
  return catalogNamesByKey.get(normalizeCatalogName(name)) ?? null
}

// Ghostty layers a theme over its defaults; cursor colors follow the theme's foreground and background unless set.
function ghosttyThemeTerminalColors(overrides: TerminalColorOverrides): TerminalColorOverrides {
  const defaults = TERMINAL_THEME_CATALOG[DEFAULT_TERMINAL_THEME_DARK] ?? {}
  const {
    cursor: _cursor,
    cursorAccent: _cursorAccent,
    selectionBackground: _selectionBackground,
    selectionForeground: _selectionForeground,
    ...defaultPalette
  } = defaults
  const terminal = normalizeTerminalColorOverrides({ ...defaultPalette, ...overrides })
  return {
    ...terminal,
    cursor: terminal.cursor ?? terminal.foreground,
    cursorAccent: terminal.cursorAccent ?? terminal.background
  }
}

type ResolvedTheme = { selection: string; name: string; custom?: TerminalCustomTheme }

async function resolveTheme(
  themeName: string,
  pickedConfigDir: string | undefined,
  existingThemes: TerminalCustomTheme[]
): Promise<ResolvedTheme | null> {
  const colors = await resolveGhosttyThemeColors(themeName, pickedConfigDir)
  if (colors === null) {
    const builtIn = findBuiltInThemeName(themeName)
    return builtIn ? { selection: builtIn, name: builtIn } : null
  }

  const name = normalizeTerminalThemeName(path.basename(themeName.replaceAll('\\', '/')))
  const id = `ghostty:${normalizeTerminalThemeId(name)}`
  const terminal = ghosttyThemeTerminalColors(
    mapGhosttyToOrca(colors).diff.terminalColorOverrides ?? {}
  )
  const existing = existingThemes.find((theme) => theme.id === id)
  // Re-importing an unchanged theme keeps its record so the preview does not report a no-op change.
  const custom: TerminalCustomTheme =
    existing && JSON.stringify(existing.terminal) === JSON.stringify(terminal)
      ? existing
      : {
          id,
          name,
          source: 'ghostty',
          mode: inferTerminalThemeMode(terminal.background),
          terminal,
          importedAt: new Date().toISOString()
        }
  return { selection: makeCustomTerminalThemeSelection(id), name, custom }
}

export async function importGhosttyTheme(
  rawValue: string,
  pickedConfigDir: string | undefined,
  currentCustomThemes: unknown
): Promise<GhosttyThemeImport> {
  const pair = parseGhosttyThemeValue(rawValue)
  if (pair === null) {
    return {
      diff: {},
      themeNames: {},
      unsupportedKeys: ['theme (light:/dark: pairs need both a light and a dark theme)']
    }
  }

  const existingThemes = normalizeTerminalCustomThemes(currentCustomThemes)
  const isPair = pair.light !== pair.dark
  const requests: [TerminalThemeSlot, string][] = isPair
    ? [
        ['dark', pair.dark],
        ['light', pair.light]
      ]
    : [['dark', pair.dark]]

  const diff: Partial<GlobalSettings> = {}
  const themeNames: GhosttyThemeImport['themeNames'] = {}
  const unsupportedKeys: string[] = []
  const importedThemes = new Map<string, TerminalCustomTheme>()
  for (const [slot, themeName] of requests) {
    const resolved = await resolveTheme(themeName, pickedConfigDir, existingThemes)
    if (resolved === null) {
      unsupportedKeys.push(`theme (${themeName}: not found)`)
      continue
    }
    if (resolved.custom) {
      const isNew = !existingThemes.some((theme) => theme.id === resolved.custom?.id)
      if (isNew && existingThemes.length + importedThemes.size >= MAX_TERMINAL_CUSTOM_THEMES) {
        unsupportedKeys.push(`theme (${themeName}: custom terminal theme limit reached)`)
        continue
      }
      importedThemes.set(resolved.custom.id, resolved.custom)
    }
    diff[slot === 'dark' ? 'terminalThemeDark' : 'terminalThemeLight'] = resolved.selection
    themeNames[slot] = resolved.name
  }

  if (themeNames.dark !== undefined || themeNames.light !== undefined) {
    // A single Ghostty theme paints both appearances, which Orca expresses as the dark slot alone.
    diff.terminalUseSeparateLightTheme = isPair && themeNames.light !== undefined
  }
  if (importedThemes.size > 0) {
    // Updated themes keep their position so an unchanged re-import produces an identical list.
    const existingIds = new Set(existingThemes.map((theme) => theme.id))
    diff.terminalCustomThemes = normalizeTerminalCustomThemes([
      ...existingThemes.map((theme) => importedThemes.get(theme.id) ?? theme),
      ...[...importedThemes.values()].filter((theme) => !existingIds.has(theme.id))
    ])
  }
  return { diff, themeNames, unsupportedKeys }
}
