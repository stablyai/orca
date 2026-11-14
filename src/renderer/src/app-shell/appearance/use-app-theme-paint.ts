import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { MATCH_TERMINAL_APP_THEME } from '../../../../shared/plugin-theme-settings'
import type { PluginThemeRegistration } from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { useAppStore } from '../../store'
import { usePluginThemeStore, usePluginThemes } from '../../store/plugins/appearance/plugin-themes'
import { useDocumentDarkTheme, useSettingsDarkTheme } from '@/hooks/use-document-dark-theme'
import { useSystemPrefersDark } from '@/hooks/theme/use-system-prefers-dark'
import {
  applyCachedPluginAppTheme,
  applyDocumentTheme,
  applyPluginAppTheme,
  readCachedPluginAppTheme,
  resolveDocumentTheme
} from './document-theme'
import { browserColorProbe } from './plugin-theme-tokens'
import {
  resolvePaintedTheme,
  synthesizeTerminalAppTheme,
  type TerminalAppTheme
} from './terminal-app-theme'

/** The Match Terminal app theme while the requested mode's slot selects it, else null. */
function useTerminalAppTheme(selected: boolean): TerminalAppTheme | null {
  const systemPrefersDark = useSystemPrefersDark()
  // Why only these fields: unrelated settings writes must not re-derive and repaint the theme.
  const inputs = useAppStore(
    useShallow((s) =>
      selected && s.settings
        ? {
            theme: s.settings.theme,
            terminalThemeDark: s.settings.terminalThemeDark,
            terminalThemeLight: s.settings.terminalThemeLight,
            terminalUseSeparateLightTheme: s.settings.terminalUseSeparateLightTheme,
            terminalCustomThemes: s.settings.terminalCustomThemes,
            terminalPluginPalettes: s.settings.terminalPluginPalettes,
            pluginSystemEnabled: s.settings.pluginSystemEnabled,
            disabledPlugins: s.settings.disabledPlugins,
            terminalColorOverrides: s.settings.terminalColorOverrides,
            terminalColorOverridesLight: s.settings.terminalColorOverridesLight
          }
        : null
    )
  )
  return useMemo(
    () =>
      inputs ? synthesizeTerminalAppTheme(inputs, systemPrefersDark, browserColorProbe) : null,
    [inputs, systemPrefersDark]
  )
}

export type AppThemePaintState = {
  theme: GlobalSettings['theme'] | undefined
  dark: boolean
  requestedDark: boolean
  appTheme: TerminalAppTheme | PluginThemeRegistration | null
  pluginTheme: PluginThemeRegistration | null
  pluginThemes: PluginThemeRegistration[]
  pluginThemesLoaded: boolean
  ready: boolean
  /** The tokens the app theme painted, after its contrast check. */
  appPainted: RefObject<Readonly<Record<string, string>>>
}

/** Paints the document in the selected app theme (a plugin's or Match Terminal's) and its mode.
 *  Every Orca window runs this, so pop-outs follow the main window's theme. */
export function useAppThemePaint(): AppThemePaintState {
  const theme = useAppStore((s) => s.settings?.theme)
  const requestedDark = useSettingsDarkTheme()
  const dark = useDocumentDarkTheme()
  const selected = useAppStore((s) =>
    requestedDark ? s.settings?.pluginAppThemeDark : s.settings?.pluginAppThemeLight
  )
  const pluginThemes = usePluginThemes()
  const matchTerminal = selected === MATCH_TERMINAL_APP_THEME
  const terminalTheme = useTerminalAppTheme(matchTerminal)
  // Why find by id: a disabled or removed plugin drops out of the list, which restores built-in colors.
  const pluginTheme =
    pluginThemes.find((entry) => entry.id === selected && (entry.base === 'dark') === dark) ?? null
  const appTheme = matchTerminal ? terminalTheme : pluginTheme
  // Why Match Terminal needn't wait: it derives from settings alone, not the plugin list.
  const pluginThemesLoaded = usePluginThemeStore((s) => s.loaded)
  const ready = matchTerminal || pluginThemesLoaded
  const appPainted = useRef<Readonly<Record<string, string>>>({})

  useEffect(() => {
    if (theme) {
      // Why the painted mode: Match Terminal may show a terminal theme of the other mode.
      applyDocumentTheme(dark ? 'dark' : 'light')
    }
  }, [theme, dark])

  useEffect(() => {
    // Why wait for the list: until it loads, the startup cache is still the right paint.
    // Why theme too: contrast is checked against the built-ins of the current mode.
    if (ready && theme) {
      appPainted.current = applyPluginAppTheme(appTheme)
    }
  }, [appTheme, ready, theme, dark])

  return {
    theme,
    dark,
    requestedDark,
    appTheme,
    pluginTheme,
    pluginThemes,
    pluginThemesLoaded,
    ready,
    appPainted
  }
}

/** First paint of a pop-out window: its mode, and its last app theme while settings still pick it.
 *  The cache lives in the window's own in-memory partition, so a first open shows built-ins until
 *  the theme list loads. */
export function applyStartupAppTheme(settings: GlobalSettings | null): void {
  const painted = resolvePaintedTheme(settings)
  applyDocumentTheme(painted, { disableTransitions: false })
  const cached = readCachedPluginAppTheme()
  const requestedDark = resolveDocumentTheme(settings?.theme ?? 'system')
  const selected = requestedDark ? settings?.pluginAppThemeDark : settings?.pluginAppThemeLight
  if (
    cached &&
    cached.id === selected &&
    (cached.base === 'dark') === resolveDocumentTheme(painted)
  ) {
    applyCachedPluginAppTheme(cached)
  }
}
