import { useEffect } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme } from '../lib/document-theme'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'
import {
  applyCustomUiThemeVariables,
  clearCustomUiThemeVariables
} from '../../../shared/custom-ui-themes'

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const settingsTheme = useAppStore((s) => s.settings?.theme)
  const activeUiTheme = useAppStore((s) => s.settings?.activeUiTheme)
  const customUiThemes = useAppStore((s) => s.settings?.customUiThemes)
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)

  useEffect(() => {
    const root = document.documentElement
    const customTheme =
      activeUiTheme && activeUiTheme !== 'default'
        ? customUiThemes?.find((theme) => theme.id === activeUiTheme)
        : undefined

    if (customTheme) {
      applyCustomUiThemeVariables(customTheme, root)
      root.classList.add('custom-ui-theme-active')
      applyDocumentTheme(customTheme.mode)
      return undefined
    }

    clearCustomUiThemeVariables(root)
    root.classList.remove('custom-ui-theme-active')
    if (!settingsTheme) {
      return undefined
    }
    if (settingsTheme === 'dark') {
      applyDocumentTheme('dark')
      return undefined
    } else if (settingsTheme === 'light') {
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
  }, [activeUiTheme, customUiThemes, settingsTheme])

  useEffect(
    () => () => {
      clearCustomUiThemeVariables(document.documentElement)
      document.documentElement.classList.remove('custom-ui-theme-active')
    },
    []
  )

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
