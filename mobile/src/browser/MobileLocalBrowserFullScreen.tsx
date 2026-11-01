import { useCallback, useState } from 'react'
import { Text } from 'react-native'
import { translate } from '../i18n/mobile-i18n'
import type { MobileLocalBrowserNetwork } from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileBrowserViewMode } from './browser-screencast-request'
import { MobileBrowserFullScreenFrame } from './MobileBrowserFullScreenFrame'
import { MobileLocalBrowser } from './MobileLocalBrowser'
import { MobileLocalBrowserToast } from './MobileLocalBrowserToast'
import type { MobileBrowserLocalTunnel } from './use-mobile-browser-local-tunnel'

type Props = {
  client: RpcClient
  hostId: string
  worktreeId: string
  url: string
  network?: MobileLocalBrowserNetwork
  viewMode: MobileBrowserViewMode
  tunnel?: MobileBrowserLocalTunnel
  onViewModeChange?: (viewMode: MobileBrowserViewMode) => void
  onNetworkChange?: (network: MobileLocalBrowserNetwork) => void
  // Leaving full screen hands back the page the view was on.
  onClose: (url: string) => void
  onStreamFromHost: () => void
}

/** A phone-drawn tab over the whole screen. */
export function MobileLocalBrowserFullScreen({
  client,
  hostId,
  worktreeId,
  url,
  network,
  viewMode,
  tunnel,
  onViewModeChange,
  onNetworkChange,
  onClose,
  onStreamFromHost
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const [toast, setToast] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [currentUrl, setCurrentUrl] = useState(url)
  const close = (): void => onClose(currentUrl)
  const dismissToast = useCallback(() => setToast(null), [])
  return (
    <MobileBrowserFullScreenFrame onRequestClose={close}>
      {failure === null ? (
        <MobileLocalBrowser
          client={client}
          hostId={hostId}
          worktreeId={worktreeId}
          initialUrl={url}
          initialNetwork={network}
          initialViewMode={viewMode}
          tunnel={tunnel}
          onViewModeChange={onViewModeChange}
          onNetworkChange={onNetworkChange}
          fullScreen={{ active: true, onToggle: close }}
          pending={
            <Text style={styles.status} onPress={close}>
              {translate('browser.shellLocal.starting', 'Connecting through the host…')}
            </Text>
          }
          onStreamFromHost={onStreamFromHost}
          onHostTunnelFailed={setFailure}
          onUrlChange={setCurrentUrl}
          onToast={setToast}
        />
      ) : (
        <Text style={styles.status} onPress={close}>
          {translate('browser.shellLocal.failed', 'Could not draw the page here: {{reason}}', {
            reason: failure
          })}
        </Text>
      )}
      <MobileLocalBrowserToast message={toast} onDismiss={dismissToast} />
    </MobileBrowserFullScreenFrame>
  )
}

const styles = themedStyleSheet(() => ({
  status: {
    margin: 24,
    color: colors.textSecondary
  }
}))
