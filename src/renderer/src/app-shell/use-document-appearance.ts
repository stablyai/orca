import { useEffect } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme, resolveDocumentTheme } from '../lib/document-theme'
import { applyTabGroupSplitDividerAppearance } from '../lib/tab-group-split-divider-appearance'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'

function applyWorkspaceSplitDivider(settings: GlobalSettings): void {
  applyTabGroupSplitDividerAppearance(
    document.documentElement,
    settings,
    resolveDocumentTheme(settings.theme)
  )
}

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const theme = useAppStore((s) => s.settings?.theme)
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)

  useEffect(() => {
    if (!theme) {
      return
    }

    if (theme === 'dark') {
      applyDocumentTheme('dark')
      applyWorkspaceSplitDivider(settings)
      return undefined
    } else if (theme === 'light') {
      applyDocumentTheme('light')
      applyWorkspaceSplitDivider(settings)
      return undefined
    }
    // system
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    applyDocumentTheme('system')
    applyWorkspaceSplitDivider(settings)
    const handler = (): void => {
      applyDocumentTheme('system')
      applyWorkspaceSplitDivider(settings)
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
