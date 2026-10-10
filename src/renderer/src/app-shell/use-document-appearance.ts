import { useEffect } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme } from '../lib/document-theme'
import { DEFAULT_INTERFACE_THEME_ID } from '../../../shared/interface-themes'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const theme = useAppStore((s) => s.settings?.theme)
  const interfaceThemeDark = useAppStore((s) => s.settings?.interfaceThemeDark)
  const interfaceThemeLight = useAppStore((s) => s.settings?.interfaceThemeLight)
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)

  useEffect(() => {
    if (!theme) {
      return
    }
    const interfaceThemes = {
      dark: interfaceThemeDark ?? DEFAULT_INTERFACE_THEME_ID,
      light: interfaceThemeLight ?? DEFAULT_INTERFACE_THEME_ID
    }

    if (theme === 'dark') {
      applyDocumentTheme('dark', { interfaceThemes })
      return undefined
    } else if (theme === 'light') {
      applyDocumentTheme('light', { interfaceThemes })
      return undefined
    }
    // system
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    applyDocumentTheme('system', { interfaceThemes })
    const handler = (): void => {
      applyDocumentTheme('system')
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme, interfaceThemeDark, interfaceThemeLight])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
