import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentAppearance } from '@/lib/app-appearance-document'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const appearanceSettings = useAppStore(
    useShallow((s) => {
      const settings = s.settings
      if (!settings) {
        return null
      }
      return {
        leftSidebarAppearanceMode: settings.leftSidebarAppearanceMode,
        leftSidebarTintColor: settings.leftSidebarTintColor,
        leftSidebarTintOpacity: settings.leftSidebarTintOpacity,
        theme: settings.theme,
        terminalThemeDark: settings.terminalThemeDark,
        terminalDividerColorDark: settings.terminalDividerColorDark,
        terminalUseSeparateLightTheme: settings.terminalUseSeparateLightTheme,
        terminalThemeLight: settings.terminalThemeLight,
        terminalCustomThemes: settings.terminalCustomThemes,
        terminalDividerColorLight: settings.terminalDividerColorLight,
        terminalColorOverrides: settings.terminalColorOverrides,
        terminalBackgroundOpacity: settings.terminalBackgroundOpacity
      }
    })
  )
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)

  useEffect(() => {
    if (!appearanceSettings) {
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyAppearance = (): void => {
      applyDocumentAppearance(appearanceSettings, media.matches)
    }
    applyAppearance()

    if (appearanceSettings.theme !== 'system') {
      return
    }
    const handler = (): void => {
      applyAppearance()
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [appearanceSettings])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
