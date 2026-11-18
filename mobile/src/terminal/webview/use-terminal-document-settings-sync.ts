import { useEffect, useMemo } from 'react'
import type { RuntimeMobileTerminalTheme } from '../../../../src/shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { TerminalHostSettings, TerminalWebViewCommand } from './terminal-webview-messages'

// Push theme and host settings changes to a live document; init carries both for a reloaded one.
export function useTerminalDocumentSettingsSync(
  postMessage: (msg: TerminalWebViewCommand) => void,
  terminalTheme: RuntimeMobileTerminalTheme | undefined,
  hostSettings: TerminalHostSettings | undefined
) {
  const terminalThemeKey = useMemo(() => JSON.stringify(terminalTheme ?? null), [terminalTheme])
  useEffect(() => {
    postMessage({ type: 'set-theme', terminalTheme })
  }, [postMessage, terminalThemeKey, terminalTheme])

  useEffect(() => {
    if (hostSettings) {
      postMessage({ type: 'set-host-settings', ...hostSettings })
    }
  }, [postMessage, hostSettings])
}
