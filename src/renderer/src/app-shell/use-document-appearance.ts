import { useEffect } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme, applyPluginAppTheme } from '../lib/document-theme'
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
  usePluginIconThemeActivation(useAppStore((s) => s.settings?.pluginIconTheme))

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
      applyPluginAppTheme(pluginTheme)
      // Why read the document: the editor should match what was painted, built-ins included.
      const computed = getComputedStyle(document.documentElement)
      usePluginMonacoThemeStore.setState({
        theme: pluginTheme
          ? derivePluginMonacoTheme({
              base: pluginTheme.base,
              read: (token) => computed.getPropertyValue(token),
              probe: browserColorProbe,
              tokenColors: pluginTheme.tokenColors
            })
          : null
      })
    }
  }, [pluginTheme, pluginThemesLoaded, theme, dark])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
