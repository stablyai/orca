import { useEffect } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme, resolveDocumentTheme } from '../lib/document-theme'
import { applyTabGroupSplitDividerAppearance } from '../lib/tab-group-split-divider-appearance'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'

type SplitDividerColors = Parameters<typeof applyTabGroupSplitDividerAppearance>[1]

function applyWorkspaceSplitDivider(
  theme: GlobalSettings['theme'],
  colors: SplitDividerColors
): void {
  applyTabGroupSplitDividerAppearance(document.documentElement, colors, resolveDocumentTheme(theme))
}

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const theme = useAppStore((s) => s.settings?.theme)
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)
  const splitDividerDark = useAppStore((s) => s.settings?.tabGroupSplitDividerColorDark)
  const splitDividerLight = useAppStore((s) => s.settings?.tabGroupSplitDividerColorLight)

  useEffect(() => {
    if (!theme) {
      return
    }
    applyDocumentTheme(theme)
    if (theme !== 'system') {
      return undefined
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => {
      applyDocumentTheme('system')
      const settings = useAppStore.getState().settings
      applyWorkspaceSplitDivider(theme, {
        tabGroupSplitDividerColorDark: settings?.tabGroupSplitDividerColorDark,
        tabGroupSplitDividerColorLight: settings?.tabGroupSplitDividerColorLight
      })
      // System theme changes don't mutate the store, so mobile terminal colors need an explicit graph republish.
      scheduleRuntimeGraphSync()
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  useEffect(() => {
    if (!theme) {
      return
    }
    applyWorkspaceSplitDivider(theme, {
      tabGroupSplitDividerColorDark: splitDividerDark,
      tabGroupSplitDividerColorLight: splitDividerLight
    })
  }, [theme, splitDividerDark, splitDividerLight])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])
}
