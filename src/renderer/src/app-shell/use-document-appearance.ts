import { useEffect, useMemo } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyCodeFontSmoothing } from '@/lib/code-font-smoothing'
import { applyMarkdownCodeFontFamily } from '@/lib/markdown-code-font'
import { rebuildAllTerminalWebglRenderers } from '@/lib/pane-manager/pane-manager-registry'
import { applyDocumentTheme, applyPluginAppTheme } from '../lib/document-theme'
import { applyThemeBackground } from '../lib/theme-background'
import { tolerantPluginThemeBackgroundRegistration } from '../../../shared/plugins/artifacts/plugin-theme-background'
import { derivePluginMonacoTheme } from '../lib/plugin-monaco-theme'
import { browserColorProbe } from '../lib/plugin-theme-tokens'
import { usePluginMonacoThemeStore } from '../store/plugin-monaco-theme'
import {
  usePluginAppThemeSync,
  usePluginTerminalPaletteRefresh,
  usePluginThemeStore,
  usePluginThemes
} from '../store/plugin-themes'
import { usePluginIconThemeActivation } from '../store/plugin-icon-themes'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { useMediaQuery } from '@/hooks/use-media-query'

export function useDocumentAppearance(): void {
  const theme = useAppStore((s) => s.settings?.theme)
  const dark = useDocumentDarkTheme()
  const selectedPluginTheme = useAppStore((s) =>
    dark ? s.settings?.pluginAppThemeDark : s.settings?.pluginAppThemeLight
  )
  // Why find by id: a disabled or removed plugin drops out of the list, which restores built-in colors.
  const pluginTheme =
    usePluginThemes().find(
      (entry) => entry.id === selectedPluginTheme && (entry.base === 'dark') === dark
    ) ?? null
  const pluginThemesLoaded = usePluginThemeStore((s) => s.loaded)
  usePluginTerminalPaletteRefresh()
  usePluginAppThemeSync()
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)
  const codeFontSmoothing = useAppStore((s) => s.settings?.codeFontSmoothing)
  const editorFontFamily = useAppStore((s) => s.settings?.editorFontFamily)
  usePluginIconThemeActivation(useAppStore((s) => s.settings?.pluginIconTheme))
  const reduceEffects = useMediaQuery('(prefers-reduced-transparency: reduce)')
  const terminalTranslucent = useAppStore((s) => (s.settings?.terminalBackgroundOpacity ?? 1) < 1)
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
      applyDocumentTheme(theme)
    }
    if (theme === 'system') {
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
  }, [theme, dark])

  useEffect(() => {
    // Why wait for the list: until it loads, the startup cache is still the right paint.
    // Why theme too: contrast is checked against the built-ins of the current mode.
    if (pluginThemesLoaded && theme) {
      const painted = applyPluginAppTheme(pluginTheme)
      // Why read the document: the editor should match what was painted, built-ins included.
      const computed = getComputedStyle(document.documentElement)
      usePluginMonacoThemeStore.setState({
        theme: pluginTheme
          ? derivePluginMonacoTheme({
              base: pluginTheme.base,
              read: (token) => computed.getPropertyValue(token),
              painted,
              probe: browserColorProbe,
              tokenColors: pluginTheme.tokenColors
            })
          : null
      })
    }
  }, [pluginTheme, pluginThemesLoaded, theme, dark])

  // Why gated: the image only shows through translucent terminals, so otherwise it would cost decode
  // and switch terminals to transparent rendering for nothing.
  useEffect(() => {
    if (pluginThemesLoaded) {
      applyThemeBackground(terminalTranslucent && !reduceEffects ? themeBackground : null)
    }
  }, [pluginThemesLoaded, terminalTranslucent, reduceEffects, themeBackground])

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
