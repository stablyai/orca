import { useRouter } from 'expo-router'
import { useCallback } from 'react'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import BrowserSettingsScreen from '../src/settings/browser-settings-screen'
import { loadWebHostTerminalPreferences } from '../src/session/web-host-session-device-operations'
import { DEFAULT_TERMINAL_LINK_OPEN_MODE } from '../src/storage/preferences'

export default function HostedBrowserSettingsRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  const loadLinkMode = useCallback(async () => {
    if (!shell.client) {
      return DEFAULT_TERMINAL_LINK_OPEN_MODE
    }
    return (await loadWebHostTerminalPreferences(shell.client)).linkOpenMode
  }, [shell.client])
  return (
    <BrowserSettingsScreen
      key={shell.context?.shellSessionId ?? 'pending'}
      onBack={() => {
        if (router.canGoBack()) {
          router.back()
        } else {
          router.replace('/settings')
        }
      }}
      scope="host"
      available={shell.client?.native.supports('pagePreferences') ?? false}
      loadLinkMode={loadLinkMode}
    />
  )
}
