import { useEffect } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import {
  applyAppAppearanceToDocument,
  clearAppAppearanceFromDocument
} from '@/lib/app-appearance-document'
import { applyDocumentTheme } from '../lib/document-theme'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const settings = useAppStore((s) => s.settings)

  useEffect(() => {
    if (!settings) {
      applyAppAppearanceToDocument(settings, true)
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyAppearance = (): void => {
      clearAppAppearanceFromDocument()
      applyDocumentTheme(settings.theme)
      applyAppAppearanceToDocument(settings, media.matches)
    }
    applyAppearance()

    if (settings.theme !== 'system') {
      return
    }
    const handler = (): void => {
      applyAppearance()
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [settings])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(settings?.appFontFamily)
    )
  }, [settings?.appFontFamily])
}
