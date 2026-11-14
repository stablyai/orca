import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  PLUGIN_APP_THEME_TOKENS,
  type PluginThemeRegistration
} from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { pluginAppThemeCssFallback } from '../../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'
import { MATCH_TERMINAL_APP_THEME } from '../../../../shared/plugin-theme-settings'
import { isPluginContentSwitchedOff } from '../../../../shared/plugins/plugin-system-settings'
import { formatThemeColor } from '../../../../shared/color/oklch-color-transform'
import { resolveTerminalPalette } from '../../../../shared/terminal-themes/terminal-theme-selection'
import { normalizeTerminalColorOverrides } from '../../../../shared/terminal-themes/terminal-custom-themes'
import {
  THEME_STUDIO_MODES,
  type ThemeStudioMode
} from '../../../../shared/theme-studio/theme-studio-draft'
import type {
  ThemeStudioResolveResult,
  ThemeStudioResolvedMode,
  ThemeStudioTokenSource
} from '../../../../shared/theme-studio/theme-studio-protocol'
import { browserColorProbe, paintedThemeColors, safePluginThemeTokens } from './plugin-theme-tokens'
import { synthesizeTerminalAppTheme } from './terminal-app-theme'
import { themeBuiltInTokens } from './theme-built-in-tokens'

/** The app theme the user picked for a mode, if it is a plugin's or Match Terminal. */
function selectedAppTheme(
  settings: GlobalSettings,
  mode: ThemeStudioMode,
  themes: readonly PluginThemeRegistration[],
  systemPrefersDark: boolean
): {
  id: string
  label: string
  pluginName: string
  tokens: Record<string, string>
  tokenColors?: PluginThemeRegistration['tokenColors']
} | null {
  const selected = mode === 'dark' ? settings.pluginAppThemeDark : settings.pluginAppThemeLight
  if (!selected || isPluginContentSwitchedOff(settings, selected)) {
    return null
  }
  if (selected === MATCH_TERMINAL_APP_THEME) {
    const synthesized = synthesizeTerminalAppTheme(
      { ...settings, theme: mode },
      systemPrefersDark,
      browserColorProbe
    )
    return synthesized?.base === mode
      ? { ...synthesized, label: 'Match Terminal', pluginName: 'Match Terminal' }
      : null
  }
  return themes.find((theme) => theme.id === selected && theme.base === mode) ?? null
}

function resolveMode(
  settings: GlobalSettings,
  mode: ThemeStudioMode,
  themes: readonly PluginThemeRegistration[],
  systemPrefersDark: boolean
): ThemeStudioResolvedMode {
  const theme = selectedAppTheme(settings, mode, themes, systemPrefersDark)
  const builtIns = themeBuiltInTokens(mode)
  const safe = safePluginThemeTokens(theme?.tokens ?? {}, mode, builtIns, browserColorProbe)
  const painted = paintedThemeColors(safe, mode, builtIns, browserColorProbe)
  const tokens = Object.fromEntries(
    PLUGIN_APP_THEME_TOKENS.map((token) => {
      const color = painted(token)
      const source: ThemeStudioTokenSource = safe[token]
        ? 'theme'
        : pluginAppThemeCssFallback(token, mode)
          ? 'derived'
          : 'built-in'
      return [token, { value: color ? formatThemeColor(color) : null, source }]
    })
  )
  const palette = resolveTerminalPalette({ ...settings, theme: mode }, systemPrefersDark).theme
  return {
    mode,
    themeId: theme?.id ?? null,
    themeLabel: theme?.label ?? null,
    themeName: theme?.pluginName ?? null,
    tokens,
    ...(theme?.tokenColors?.length ? { tokenColors: theme.tokenColors } : {}),
    terminal: { ...normalizeTerminalColorOverrides(palette ?? {}) }
  }
}

/** What the user's own themes paint in each mode, ignoring any draft being previewed. */
export function resolveThemeStudioModes(input: {
  settings: GlobalSettings
  themes: readonly PluginThemeRegistration[]
  systemPrefersDark: boolean
  shownMode: ThemeStudioMode
}): ThemeStudioResolveResult {
  return {
    shownMode: input.shownMode,
    modes: THEME_STUDIO_MODES.map((mode) =>
      resolveMode(input.settings, mode, input.themes, input.systemPrefersDark)
    )
  }
}
