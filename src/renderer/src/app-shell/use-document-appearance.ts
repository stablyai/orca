import { useEffect } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme, applyPluginAppTheme } from '../lib/document-theme'
import {
  usePluginAppThemeSync,
  usePluginTerminalPaletteRefresh,
  usePluginThemeStore,
  usePluginThemes
} from '../store/plugin-themes'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const selectedPluginTheme = useAppStore((s) => s.settings?.pluginAppTheme)
  // Why find by id: a disabled or removed plugin drops out of the list, which restores built-in colors.
  const pluginTheme = usePluginThemes().find((entry) => entry.id === selectedPluginTheme) ?? null
  const pluginThemesLoaded = usePluginThemeStore((s) => s.loaded)
  // Why settings.theme alone: choosing a plugin theme stores its base there, so every reader of
  // the light/dark mode agrees with the painted colors.
  const theme = useAppStore((s) => s.settings?.theme)
  usePluginTerminalPaletteRefresh()
  usePluginAppThemeSync()
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)

  useEffect(() => {
    if (!theme) {
      return
    }

    if (theme === 'dark') {
      applyDocumentTheme('dark')
      return undefined
    } else if (theme === 'light') {
      applyDocumentTheme('light')
      return undefined
    }
    // system
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    applyDocumentTheme('system')
    const handler = (): void => {
      applyDocumentTheme('system')
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  useEffect(() => {
    // Why wait for the list: until it loads, the startup cache is still the right paint.
    // Why theme too: contrast is checked against the built-ins of the current mode.
    if (pluginThemesLoaded && theme) {
      applyPluginAppTheme(pluginTheme)
    }
  }, [pluginTheme, pluginThemesLoaded, theme])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
