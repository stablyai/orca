import { platform } from 'node:os'
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
  TERMINAL_ANSI_COLOR_KEYS,
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

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

// Mirrors Ghostty's Theme.parseCLI: a comma, colon or `=` marks a light/dark pair written as `light:X,dark:Y`.
export function parseGhosttyThemeValue(
  value: string,
  plat: NodeJS.Platform = platform()
): GhosttyThemePair | null {
  const trimmed = value.trim()
  const isDrivePath = plat === 'win32' && /^[a-zA-Z]:/.test(trimmed) && !trimmed.includes(',')
  if (!/[,:=]/.test(trimmed) || isDrivePath) {
    return trimmed ? { light: trimmed, dark: trimmed } : null
  }
  const pair: Partial<GhosttyThemePair> = {}
  for (const part of trimmed.split(',')) {
    const separator = part.indexOf(':')
    const slot = part.slice(0, Math.max(separator, 0)).trim()
    const name = unquote(part.slice(separator + 1).trim())
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
  const terminal = { ...defaultPalette, ...overrides }
  // Normalizing last keeps key order stable so unchanged re-imports compare equal.
  return normalizeTerminalColorOverrides({
    ...terminal,
    cursor: terminal.cursor ?? terminal.foreground,
    cursorAccent: terminal.cursorAccent ?? terminal.background
  })
}

function hasSamePalette(terminal: TerminalColorOverrides, builtIn: unknown): boolean {
  const builtInColors = normalizeTerminalColorOverrides(builtIn)
  return (['background', 'foreground', ...TERMINAL_ANSI_COLOR_KEYS] as const).every(
    (key) => terminal[key] === builtInColors[key]
  )
}

type ResolvedTheme = {
  selection: string
  name: string
  custom?: TerminalCustomTheme
  dividerColor?: string
}

async function resolveTheme(
  themeName: string,
  slot: TerminalThemeSlot,
  pickedConfigDir: string | undefined,
  existingThemes: TerminalCustomTheme[],
  claimedThemes: Map<string, TerminalCustomTheme>
): Promise<ResolvedTheme | null> {
  const colors = await resolveGhosttyThemeColors(themeName, pickedConfigDir)
  const builtIn = findBuiltInThemeName(themeName)
  if (colors === null) {
    return builtIn ? { selection: builtIn, name: builtIn } : null
  }

  const themeDiff = mapGhosttyToOrca(colors).diff
  const terminal = ghosttyThemeTerminalColors(themeDiff.terminalColorOverrides ?? {})
  const dividerColor = themeDiff.terminalDividerColorDark
  // A Ghostty theme Orca already ships selects the built-in instead of adding a same-named duplicate.
  if (builtIn && hasSamePalette(terminal, TERMINAL_THEME_CATALOG[builtIn])) {
    return { selection: builtIn, name: builtIn, dividerColor }
  }
  const fileName = normalizeTerminalThemeName(path.basename(themeName.replaceAll('\\', '/')))
  // Ghostty's palette differs from Orca's same-named built-in, so the label tells the two apart.
  let name = builtIn ? `${fileName} (Ghostty)` : fileName
  let id = `ghostty:${normalizeTerminalThemeId(name)}`
  const claimed = claimedThemes.get(id)
  // Two different files with one basename (light:/a/x,dark:/b/x) must not overwrite each other.
  if (claimed && JSON.stringify(claimed.terminal) !== JSON.stringify(terminal)) {
    name = `${name} (${slot === 'dark' ? 'Dark' : 'Light'})`
    id = `ghostty:${normalizeTerminalThemeId(name)}`
  }
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
  return { selection: makeCustomTerminalThemeSelection(id), name, custom, dividerColor }
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
  let newThemeCount = 0
  for (const [slot, themeName] of requests) {
    const resolved = await resolveTheme(
      themeName,
      slot,
      pickedConfigDir,
      existingThemes,
      importedThemes
    )
    if (resolved === null) {
      unsupportedKeys.push(`theme (${themeName}: not found)`)
      continue
    }
    if (resolved.custom) {
      const isNew =
        !importedThemes.has(resolved.custom.id) &&
        !existingThemes.some((theme) => theme.id === resolved.custom?.id)
      if (isNew && existingThemes.length + newThemeCount >= MAX_TERMINAL_CUSTOM_THEMES) {
        unsupportedKeys.push(`theme (${themeName}: custom terminal theme limit reached)`)
        continue
      }
      newThemeCount += isNew ? 1 : 0
      importedThemes.set(resolved.custom.id, resolved.custom)
    }
    diff[slot === 'dark' ? 'terminalThemeDark' : 'terminalThemeLight'] = resolved.selection
    themeNames[slot] = resolved.name
    // A theme's divider color follows its slot; a single theme paints both appearances.
    if (resolved.dividerColor && (slot === 'light' || !isPair)) {
      diff.terminalDividerColorLight = resolved.dividerColor
    }
    if (resolved.dividerColor && slot === 'dark') {
      diff.terminalDividerColorDark = resolved.dividerColor
    }
  }

  // A single Ghostty theme paints both appearances, which Orca expresses as the dark slot alone.
  if (!isPair && themeNames.dark !== undefined) {
    diff.terminalUseSeparateLightTheme = false
  } else if (isPair && themeNames.light !== undefined) {
    diff.terminalUseSeparateLightTheme = true
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
