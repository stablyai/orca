/**
 * Cold-start seed of the view-attribute store from persisted GlobalSettings.
 * Same pipeline as the renderer snapshot: slot pick → compose ITheme → view attrs.
 */
import * as electron from 'electron'
import type { ITheme } from '@xterm/xterm'
import {
  normalizeAgentTerminalThemes,
  resolveAgentThemeSelection
} from '../../shared/agent-terminal-themes'
import { composeActiveTerminalTheme } from '../../shared/compose-active-terminal-theme'
import { getSharedTerminalTheme } from '../../shared/terminal-themes'
import { composeTerminalViewAttributes } from '../../shared/terminal-view-attributes-composition'
import {
  normalizeTerminalCustomThemes,
  parseCustomTerminalThemeSelection,
  terminalCustomThemeToXtermTheme
} from '../../shared/terminal-custom-themes'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { GlobalSettings, TuiAgent } from '../../shared/types'
import {
  commitTerminalViewAttributesSnapshot,
  hasRendererCommittedSnapshot
} from './terminal-view-attribute-store'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'

const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'

export const TERMINAL_VIEW_ATTRIBUTE_SEED_KEYS = [
  'theme',
  'terminalThemeDark',
  'terminalThemeLight',
  'terminalUseSeparateLightTheme',
  'terminalCustomThemes',
  'agentTerminalThemes',
  'terminalColorOverrides',
  'terminalBackgroundOpacity',
  'terminalCursorOpacity',
  'terminalCursorStyle',
  'terminalCursorBlink'
] as const satisfies readonly (keyof GlobalSettings)[]

type SeedSettings = Pick<
  GlobalSettings,
  | 'theme'
  | 'terminalThemeDark'
  | 'terminalThemeLight'
  | 'terminalUseSeparateLightTheme'
  | 'terminalCustomThemes'
  | 'agentTerminalThemes'
  | 'terminalColorOverrides'
  | 'terminalBackgroundOpacity'
  | 'terminalCursorOpacity'
  | 'terminalCursorStyle'
  | 'terminalCursorBlink'
>

let nativeThemeSeedingInstalled = false

function getNativeTheme():
  | {
      shouldUseDarkColors?: boolean
      on?: (event: 'updated', listener: () => void) => void
    }
  | undefined {
  try {
    // Why try/catch: Vitest throws when an electron mock omits the nativeTheme export.
    return electron.nativeTheme
  } catch {
    return undefined
  }
}

export function readSystemPrefersDarkForSeed(): boolean {
  return getNativeTheme()?.shouldUseDarkColors === true
}

export function settingsAffectTerminalViewAttributes(
  updates: Partial<GlobalSettings>
): boolean {
  return TERMINAL_VIEW_ATTRIBUTE_SEED_KEYS.some((key) => key in updates)
}

function lookupTheme(settings: SeedSettings, selection: string): ITheme | null {
  const customId = parseCustomTerminalThemeSelection(selection)
  if (customId) {
    const custom = normalizeTerminalCustomThemes(settings.terminalCustomThemes).find(
      (theme) => theme.id === customId
    )
    return custom ? terminalCustomThemeToXtermTheme(custom) : null
  }
  return getSharedTerminalTheme(selection)
}

function previewTheme(
  settings: SeedSettings,
  selection: string,
  fallbackMode: 'dark' | 'light'
): ITheme | null {
  return (
    lookupTheme(settings, selection) ??
    getSharedTerminalTheme(
      fallbackMode === 'light' ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
    )
  )
}

function composeSlot(
  settings: SeedSettings,
  prefersDark: boolean,
  agent?: TuiAgent | null
): TerminalViewAttributes {
  const sourceTheme =
    settings.theme === 'system' ? (prefersDark ? 'dark' : 'light') : settings.theme
  const useLightVariant = sourceTheme === 'light' && settings.terminalUseSeparateLightTheme
  const slot = useLightVariant ? 'light' : 'dark'
  const themeName = resolveAgentThemeSelection(settings, slot, agent)
  const theme = composeActiveTerminalTheme(
    previewTheme(settings, themeName, useLightVariant ? 'light' : 'dark'),
    settings
  )
  return composeTerminalViewAttributes(theme, sourceTheme, settings)
}

export function buildSeededTerminalViewAttributesSnapshot(
  settings: SeedSettings,
  prefersDark: boolean
): { global: TerminalViewAttributes; byAgent: Partial<Record<TuiAgent, TerminalViewAttributes>> } {
  const global = composeSlot(settings, prefersDark)
  const byAgent: Partial<Record<TuiAgent, TerminalViewAttributes>> = {}
  for (const agent of Object.keys(normalizeAgentTerminalThemes(settings.agentTerminalThemes))) {
    if (!isTuiAgent(agent)) {
      continue
    }
    byAgent[agent] = composeSlot(settings, prefersDark, agent)
  }
  return { global, byAgent }
}

export function seedTerminalViewAttributesFromSettings(
  settings: SeedSettings,
  prefersDark: boolean
): void {
  commitTerminalViewAttributesSnapshot(
    buildSeededTerminalViewAttributesSnapshot(settings, prefersDark)
  )
}

export function installTerminalViewAttributeNativeThemeSeeding(
  getSettings: () => SeedSettings
): void {
  const theme = getNativeTheme()
  if (nativeThemeSeedingInstalled || typeof theme?.on !== 'function') {
    return
  }
  nativeThemeSeedingInstalled = true
  theme.on('updated', () => {
    if (hasRendererCommittedSnapshot()) {
      return
    }
    seedTerminalViewAttributesFromSettings(getSettings(), readSystemPrefersDarkForSeed())
  })
}

export function _resetNativeThemeViewAttributeSeedingForTest(): void {
  nativeThemeSeedingInstalled = false
}
