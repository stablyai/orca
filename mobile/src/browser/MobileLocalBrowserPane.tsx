import { useRef, useState } from 'react'
import { View } from 'react-native'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  MonitorUp,
  RefreshCw,
  Server,
  Smartphone
} from 'lucide-react-native'
import {
  OrcaProxiedBrowser,
  orcaProxiedBrowserView,
  type OrcaProxiedBrowserViewHandle,
  type ProxiedBrowserNavigationState
} from '../../modules/orca-proxied-browser/src'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileLocalBrowserNetwork } from '../storage/preferences'
import type { MobileBrowserViewMode } from './browser-screencast-request'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { displayBrowserUrl, normalizeBrowserUrl } from './browser-url'
import { buttonColor } from './mobile-browser-frame-state'
import { mobileBrowserPaneStyles as styles } from './mobile-browser-pane-styles'
import { MobileBrowserAddressField } from './MobileBrowserAddressField'
import { MobileBrowserToolbarIconButton } from './MobileBrowserToolbarIconButton'
import { MobileBrowserViewModeSwitch } from './MobileBrowserViewModeSwitch'

type Props = {
  network: MobileLocalBrowserNetwork
  // Unused on the phone's network.
  proxyKey: string
  storeId: string
  initialUrl: string
  // Desktop or mobile site layout, as in the streamed browser.
  viewMode: MobileBrowserViewMode
  onViewModeChange: (mode: MobileBrowserViewMode) => void
  // Full screen is a separate view; this button opens or leaves it.
  fullScreen: { active: boolean; onToggle: () => void } | null
  // Switch this tab back to frames streamed from the host's browser.
  onStreamFromHost: () => void
  onNetworkChange: (network: MobileLocalBrowserNetwork) => void
  onUrlChange: (url: string) => void
  onToast: (message: string, durationMs?: number) => void
}

// Resolved once: binaries without the module never render this pane (canRenderBrowserLocally).
const ProxiedBrowserView = OrcaProxiedBrowser ? orcaProxiedBrowserView() : null

const IDLE_STATE: ProxiedBrowserNavigationState = {
  url: '',
  title: '',
  loading: true,
  canGoBack: false,
  canGoForward: false,
  progress: 0
}

function networkButtonColor(active: boolean): string {
  return active ? colors.accentBlue : buttonColor(true)
}

/** Draws the page in a web view on this phone, connecting through the host or on the phone's own network. */
export function MobileLocalBrowserPane({
  network,
  proxyKey,
  storeId,
  initialUrl,
  viewMode,
  onViewModeChange,
  fullScreen,
  onStreamFromHost,
  onNetworkChange,
  onUrlChange,
  onToast
}: Props): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const viewRef = useRef<OrcaProxiedBrowserViewHandle>(null)
  const [url, setUrl] = useState(initialUrl)
  const [navigation, setNavigation] = useState(IDLE_STATE)
  const [addressValue, setAddressValue] = useState(displayBrowserUrl(initialUrl))
  const [addressFocused, setAddressFocused] = useState(false)

  const navigateToAddress = (): void => {
    const next = normalizeBrowserUrl(addressValue)
    if (!next) {
      return
    }
    setAddressFocused(false)
    setUrl(next)
  }

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <MobileBrowserToolbarIconButton
          disabled={!navigation.canGoBack}
          label={t('common.back', 'Back')}
          onPress={() => void viewRef.current?.goBack()}
        >
          <ChevronLeft size={15} color={buttonColor(navigation.canGoBack)} />
        </MobileBrowserToolbarIconButton>
        <MobileBrowserToolbarIconButton
          disabled={!navigation.canGoForward}
          label={t('browser.paneView.forward', 'Forward')}
          onPress={() => void viewRef.current?.goForward()}
        >
          <ChevronRight size={15} color={buttonColor(navigation.canGoForward)} />
        </MobileBrowserToolbarIconButton>
        <MobileBrowserToolbarIconButton
          label={t('browser.paneView.reload', 'Reload')}
          onPress={() => void viewRef.current?.reload()}
        >
          <RefreshCw size={15} color={buttonColor(true)} />
        </MobileBrowserToolbarIconButton>
        <MobileBrowserAddressField
          value={addressValue}
          onChangeText={setAddressValue}
          onFocus={() => setAddressFocused(true)}
          onBlur={() => setAddressFocused(false)}
          onSubmit={navigateToAddress}
          focused={addressFocused}
          disabled={false}
          loading={navigation.loading}
          loadFailed={navigation.error !== undefined}
        />
        <MobileBrowserViewModeSwitch
          disabled={false}
          value={viewMode}
          onChange={onViewModeChange}
        />
        <MobileBrowserToolbarIconButton
          label={t('browser.localPane.streamFromHost', 'Stream from the host instead')}
          onPress={onStreamFromHost}
        >
          <MonitorUp size={15} color={buttonColor(true)} />
        </MobileBrowserToolbarIconButton>
        <MobileBrowserToolbarIconButton
          label={t('browser.localPane.throughHost', 'Connect through the host')}
          onPress={() => onNetworkChange('host')}
        >
          <Server size={15} color={networkButtonColor(network === 'host')} />
        </MobileBrowserToolbarIconButton>
        <MobileBrowserToolbarIconButton
          label={t('browser.localPane.phoneNetwork', "Connect on the phone's network")}
          onPress={() => onNetworkChange('phone')}
        >
          <Smartphone size={15} color={networkButtonColor(network === 'phone')} />
        </MobileBrowserToolbarIconButton>
        {fullScreen && (
          <MobileBrowserToolbarIconButton
            label={
              fullScreen.active
                ? t('browser.localPane.leaveFullScreen', 'Leave full screen')
                : t('browser.localPane.fullScreen', 'Full screen')
            }
            onPress={fullScreen.onToggle}
          >
            {fullScreen.active ? (
              <Minimize2 size={15} color={buttonColor(true)} />
            ) : (
              <Maximize2 size={15} color={buttonColor(true)} />
            )}
          </MobileBrowserToolbarIconButton>
        )}
      </View>
      <View style={styles.viewport}>
        {ProxiedBrowserView && (
          <ProxiedBrowserView
            ref={viewRef}
            style={styles.viewport}
            proxyKey={proxyKey}
            storeId={storeId}
            url={url}
            direct={network === 'phone'}
            desktopSite={viewMode === 'web'}
            onNavigationState={(event) => {
              const next = event.nativeEvent
              setNavigation(next)
              if (next.url) {
                onUrlChange(next.url)
                if (!addressFocused) {
                  setAddressValue(displayBrowserUrl(next.url))
                }
              }
              if (next.error) {
                onToast(
                  t('browser.localPane.loadFailed', 'Page did not load: {{error}}', {
                    error: next.error
                  })
                )
              }
            }}
          />
        )}
      </View>
    </View>
  )
}
