import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyCodeFontSmoothing } from '@/lib/code-font-smoothing'
import { applyMarkdownCodeFontFamily } from '@/lib/markdown-code-font'
import { rebuildAllTerminalWebglRenderers } from '@/lib/pane-manager/pane-manager-registry'
import { applyDocumentTheme, applyPluginAppTheme } from '../lib/document-theme'
import { applyThemeBackground } from '../lib/theme-background'
import { tolerantPluginThemeBackgroundRegistration } from '../../../shared/plugins/artifacts/plugin-theme-background'
import {
  findCodeEditorTheme,
  paintCodeEditorColors,
  resolveCodeEditorTheme
} from '../lib/code-editor-theme'
import { browserColorProbe } from '../lib/plugin-theme-tokens'
import { useCodeEditorThemeStore } from '../store/code-editor-theme'
import { synthesizeTerminalAppTheme, type TerminalAppTheme } from '../lib/terminal-app-theme'
import { MATCH_TERMINAL_APP_THEME } from '../../../shared/plugin-theme-settings'
import {
  usePluginAppThemeSync,
  usePluginTerminalPaletteRefresh,
  usePluginThemeStore,
  usePluginThemes
} from '../store/plugin-themes'
import { usePluginIconThemeActivation } from '../store/plugin-icon-themes'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'
import { useDocumentDarkTheme, useSettingsDarkTheme } from '@/hooks/use-document-dark-theme'
import { useReduceVisualEffects } from '@/hooks/use-reduce-visual-effects'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'

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

export function useDocumentAppearance(): void {
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
  const editorTheme = findCodeEditorTheme(
    useAppStore((s) => (dark ? s.settings?.editorThemeDark : s.settings?.editorThemeLight)),
    pluginThemes
  )
  // Why Match Terminal needn't wait: it derives from settings alone, not the plugin list.
  const pluginThemesLoaded = usePluginThemeStore((s) => s.loaded)
  const appPainted = useRef<Readonly<Record<string, string>>>({})
  const ready = matchTerminal || pluginThemesLoaded
  usePluginTerminalPaletteRefresh()
  usePluginAppThemeSync()
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)
  const codeFontSmoothing = useAppStore((s) => s.settings?.codeFontSmoothing)
  const editorFontFamily = useAppStore((s) => s.settings?.editorFontFamily)
  usePluginIconThemeActivation(useAppStore((s) => s.settings?.pluginIconTheme))
  const reduceEffects = useReduceVisualEffects(useAppStore((s) => s.settings?.reduceVisualEffects))
  const surfaceOpacity = useAppStore((s) => s.settings?.terminalBackgroundOpacity ?? 1)
  // Why re-parse: the theme list keeps the registration as received, and a newer host may send
  // a background this build cannot paint; it must drop to no image, never reach CSS.
  const registeredBackground = pluginTheme?.background
  const themeBackground = useMemo(
    () => tolerantPluginThemeBackgroundRegistration.parse(registeredBackground),
    [registeredBackground]
  )

  // Why `dark` too: a system theme repaints when the OS flips, before the slot paint below.
  useEffect(() => {
    if (theme) {
      // Why the painted mode: Match Terminal may show a terminal theme of the other mode.
      applyDocumentTheme(dark ? 'dark' : 'light')
    }
    if (theme === 'system') {
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    // Why requestedDark: an OS flip can change the terminal palette without changing `dark`.
  }, [theme, dark, requestedDark])

  useEffect(() => {
    // Why wait for the list: until it loads, the startup cache is still the right paint.
    // Why theme too: contrast is checked against the built-ins of the current mode.
    if (ready && theme) {
      appPainted.current = applyPluginAppTheme(appTheme)
    }
  }, [appTheme, ready, theme, dark])

  // Why gated: the image only shows through translucent terminals and chats, so otherwise it would
  // cost decode and switch terminals to transparent rendering for nothing.
  useEffect(() => {
    if (pluginThemesLoaded) {
      applyThemeBackground(
        surfaceOpacity < 1 && !reduceEffects ? themeBackground : null,
        surfaceOpacity
      )
    }
  }, [pluginThemesLoaded, surfaceOpacity, reduceEffects, themeBackground])

  // Why after the paint above: a followed editor reads the colors it just painted. Built-in
  // choices resolve before the plugin list loads; a plugin choice follows the app until then.
  useEffect(() => {
    if (!theme) {
      return
    }
    const computed = getComputedStyle(document.documentElement)
    const codeEditorTheme = resolveCodeEditorTheme({
      dark,
      appTheme,
      selected: editorTheme,
      appPainted: appPainted.current,
      readDocument: (token) => computed.getPropertyValue(token),
      probe: browserColorProbe
    })
    paintCodeEditorColors(codeEditorTheme.override)
    useCodeEditorThemeStore.setState(codeEditorTheme)
  }, [appTheme, editorTheme, pluginThemesLoaded, theme, dark])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])

  useEffect(() => {
    applyMarkdownCodeFontFamily(editorFontFamily)
  }, [editorFontFamily])

  useEffect(() => {
    // WebGL glyph atlases keep the smoothing they were created with; rebuild only on a real change.
    if (applyCodeFontSmoothing(codeFontSmoothing)) {
      rebuildAllTerminalWebglRenderers('code-font-smoothing')
    }
  }, [codeFontSmoothing])
}
