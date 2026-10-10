import { useEffect } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme } from '../lib/document-theme'
import { getOmarchyThemePalette, setOmarchyThemePalette } from '../lib/omarchy-theme-state'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const theme = useAppStore((s) => s.settings?.theme)
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)
  const omarchyTheme = useAppStore((s) => s.settings?.omarchyTheme === true)

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
    if (!omarchyTheme) {
      setOmarchyThemePalette(null)
      return undefined
    }
    let disposed = false
    const unsubscribe = window.api.settings.onOmarchyThemeChanged(setOmarchyThemePalette)
    void window.api.settings.readOmarchyTheme().then((palette) => {
      // A pushed palette is newer than this startup read, so never overwrite it.
      if (!disposed && palette && !getOmarchyThemePalette()) {
        setOmarchyThemePalette(palette)
      }
    })
    return () => {
      disposed = true
      unsubscribe()
      setOmarchyThemePalette(null)
    }
  }, [omarchyTheme])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
