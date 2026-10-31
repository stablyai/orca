import { useCallback, useState } from 'react'
import { Modal, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { translate } from '../i18n/mobile-i18n'
import type { MobileLocalBrowserNetwork } from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileBrowserViewMode } from './browser-screencast-request'
import { MobileLocalBrowser } from './MobileLocalBrowser'
import { MobileLocalBrowserToast } from './MobileLocalBrowserToast'

type Props = {
  client: RpcClient
  hostId: string
  worktreeId: string
  url: string
  network?: MobileLocalBrowserNetwork
  viewMode: MobileBrowserViewMode
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
  onClose,
  onStreamFromHost
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  const [toast, setToast] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [currentUrl, setCurrentUrl] = useState(url)
  const close = (): void => onClose(currentUrl)
  const dismissToast = useCallback(() => setToast(null), [])
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {failure === null ? (
          <MobileLocalBrowser
            client={client}
            hostId={hostId}
            worktreeId={worktreeId}
            initialUrl={url}
            initialNetwork={network}
            initialViewMode={viewMode}
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
      </View>
    </Modal>
  )
}

const styles = themedStyleSheet(() => ({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  status: {
    margin: 24,
    color: colors.textSecondary
  }
}))
