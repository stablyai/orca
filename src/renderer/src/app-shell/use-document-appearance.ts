import { useEffect } from 'react'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { applyDocumentTheme } from '../lib/document-theme'
import { scheduleRuntimeGraphSync } from '../runtime/sync-runtime-graph'
import { useAppStore } from '../store'
import {
  normalizeInterfaceGlassOpacity,
  normalizeNativeChatGlassOpacity
} from '../../../shared/window-glass'

/** Applies the settings-driven theme and app font to the document root. */
export function useDocumentAppearance(): void {
  const theme = useAppStore((s) => s.settings?.theme)
  const appFontFamily = useAppStore((s) => s.settings?.appFontFamily)
  const nativeChatGlassOpacity = useAppStore((s) => s.settings?.nativeChatGlassOpacity)
  const interfaceGlass = useAppStore((s) => s.settings?.interfaceGlass === true)
  const terminalChatGlass = useAppStore((s) => s.settings?.terminalChatGlass === true)
  const interfaceGlassOpacity = useAppStore((s) => s.settings?.interfaceGlassOpacity)

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
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(appFontFamily)
    )
  }, [appFontFamily])

  useEffect(() => {
    const root = document.documentElement
    const windowGlass = window.api?.platform?.get().windowGlass === true
    root.classList.toggle('window-glass', windowGlass)
    root.classList.toggle('interface-glass', windowGlass && interfaceGlass)
    root.classList.toggle('terminal-chat-glass', windowGlass && terminalChatGlass)
    root.style.setProperty(
      '--native-chat-glass-opacity',
      String(normalizeNativeChatGlassOpacity(nativeChatGlassOpacity))
    )
    root.style.setProperty(
      '--interface-glass-opacity',
      String(normalizeInterfaceGlassOpacity(interfaceGlassOpacity))
    )
  }, [nativeChatGlassOpacity, interfaceGlass, interfaceGlassOpacity, terminalChatGlass])
}
