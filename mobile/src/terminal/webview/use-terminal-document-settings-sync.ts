import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { RuntimeMobileTerminalTheme } from '../../../../src/shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type {
  TerminalChromeColors,
  TerminalHostSettings,
  TerminalWebViewCommand
} from './terminal-webview-messages'
import { getMobilePalette, type MobilePalette } from '../../theme/mobile-theme'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

/** The selection menu's colours from the app's current scheme. */
export function terminalChromeColors(
  palette: MobilePalette = getMobilePalette()
): TerminalChromeColors {
  return {
    surface: palette.bgRaised,
    text: palette.textPrimary,
    line: palette.borderSubtle,
    pressed: palette.translucentFill,
    accent: palette.accentBlue
  }
}

// Push theme and host settings changes to a live document; init reads the latest settings from the ref.
// A ref, not a handle dependency: a new handle would make the pane drop its queued gesture input.
export function useTerminalDocumentSettingsSync(
  postMessage: (msg: TerminalWebViewCommand) => void,
  terminalTheme: RuntimeMobileTerminalTheme | undefined,
  hostSettings: TerminalHostSettings | undefined
): RefObject<TerminalHostSettings | undefined> {
  const palette = useMobileColors()
  useEffect(() => {
    postMessage({ type: 'set-chrome', chrome: terminalChromeColors(palette) })
  }, [postMessage, palette])
  const hostSettingsRef = useRef(hostSettings)
  const terminalThemeKey = useMemo(() => JSON.stringify(terminalTheme ?? null), [terminalTheme])
  useEffect(() => {
    postMessage({ type: 'set-theme', terminalTheme })
  }, [postMessage, terminalThemeKey, terminalTheme])

  // Written during commit so an init sent right after reads the settings this render committed.
  useLayoutEffect(() => {
    hostSettingsRef.current = hostSettings
  }, [hostSettings])

  useEffect(() => {
    if (hostSettings) {
      postMessage({ type: 'set-host-settings', ...hostSettings })
    }
  }, [postMessage, hostSettings])
  return hostSettingsRef
}
