import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import {
  ActivityIndicator,
  Image,
  Text,
  TextInput,
  View,
  type PanResponderInstance,
  type HostInstance
} from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useKeyboardPersistingTaps } from '../../platform/keyboard/keyboard-persisting-taps'
import { useOptionalHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { MobileStateButton } from '../../components/feedback/MobileStateView'
import { MobileBrowserBottomBar } from './MobileBrowserBottomBar'
import { useNewBrowserTabAddressFocus } from './new-browser-tab-address-focus'
import { MobileBrowserJavaScriptDialog } from './MobileBrowserJavaScriptDialog'
import { MobileBrowserPagePrompt } from './MobileBrowserPagePrompt'
import type { MobileBrowserPagePromptState } from '../page-interaction/use-mobile-browser-page-prompts'
import { MobileBrowserPageKeys } from './MobileBrowserPageKeys'
import { MobileBrowserLoadFailure, useMobileBrowserLoadFailure } from './MobileBrowserLoadFailure'
import { useMobileBrowserPageMenu } from './use-mobile-browser-page-menu'
import { useMobileBrowserLiveTyping } from '../page-interaction/use-mobile-browser-live-typing'
import type { MobileBrowserPageInput } from '../page-interaction/use-mobile-browser-page-input-queue'
import { mobileBrowserPaneStylesSheet as stylesSheet } from './mobile-browser-pane-styles'
import type { BrowserFrameLayerBinding } from '../screencast/browser-frame-pacer'
import type {
  BrowserFrameGeometry,
  BrowserTouchLayout,
  BrowserZoomState
} from '../page-interaction/browser-touch-geometry'
import type { MobileBrowserViewMode } from '../screencast/browser-screencast-request-parameters'
import type { MobileBrowserTab } from '../../session/tabs/mobile-session-tabs'
import type { BrowserDialogState } from '../screencast/mobile-browser-stream-events'
import type { MobileCertificateProceedFailure } from '../certificate/mobile-browser-certificate-proceed'
import { useThemedStyles } from '../../theme/themed-styles'

type MobileBrowserPaneViewProps = {
  /** Just the page and typing, for a sign-in: no address, page buttons or ⋯. */
  bare?: boolean
  /** Drawn over the page's foot, e.g. a sheet's own toast where the screen's would sit under it. */
  pageOverlay?: ReactNode
  addressFocused: boolean
  addressValue: string
  bottomInset: number
  browserViewMode: MobileBrowserViewMode
  busy: boolean
  certificateTrustSupported: boolean
  controlsDisabled: boolean
  dialog: BrowserDialogState | null
  pagePrompt: MobileBrowserPagePromptState | null
  answerPagePrompt: (value: unknown) => Promise<void>
  error: string | null
  frameGeometry: BrowserFrameGeometry | null
  frameLayers: readonly [BrowserFrameLayerBinding, BrowserFrameLayerBinding]
  goBack: () => void
  goForward: () => void
  keyboardLift: number
  layoutRef: RefObject<BrowserTouchLayout | null>
  navigateToAddress: () => Promise<void>
  panResponder: PanResponderInstance
  proceedCertificate: (challengeId: string) => Promise<MobileCertificateProceedFailure | null>
  reconnectStream: () => void
  reloadPage: () => void
  retryFailedLoad: () => void
  renderedFrameSource: { uri: string } | null
  selectBrowserViewMode: (mode: MobileBrowserViewMode) => void
  sendDialogCommand: (
    method: 'browser.dialogDismiss' | 'browser.dialogAccept',
    promptText?: string
  ) => Promise<void>
  pageInput: MobileBrowserPageInput
  onToast: (message: string, durationMs?: number) => void
  setAddressFocused: Dispatch<SetStateAction<boolean>>
  setAddressValue: Dispatch<SetStateAction<string>>
  setLayout: Dispatch<SetStateAction<BrowserTouchLayout | null>>
  setRootViewRef: (view: HostInstance | null) => void
  showStop: boolean
  stopPage: () => void
  /** Why the host stopped the stream; the frame on screen is the last one it sent. */
  streamStopped: string | null
  tab: MobileBrowserTab
  zoom: BrowserZoomState
}

// Frame cap can leave viewport unpainted despite live stream; oversized frames are dropped, never fatal.
// Area budget prevents starvation: C6.6 with budget disabled measured 299 dropped/6 applied and a persistent spinner.
export function MobileBrowserPaneView(props: MobileBrowserPaneViewProps) {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const {
    bare = false,
    pageOverlay,
    addressFocused,
    addressValue,
    bottomInset,
    browserViewMode,
    busy,
    certificateTrustSupported,
    controlsDisabled,
    dialog,
    pagePrompt,
    answerPagePrompt,
    error,
    frameGeometry,
    frameLayers,
    goBack,
    goForward,
    keyboardLift,
    layoutRef,
    navigateToAddress,
    panResponder,
    proceedCertificate,
    reconnectStream,
    reloadPage,
    retryFailedLoad,
    renderedFrameSource,
    selectBrowserViewMode,
    sendDialogCommand,
    pageInput,
    onToast,
    setAddressFocused,
    setAddressValue,
    setLayout,
    setRootViewRef,
    showStop,
    stopPage,
    streamStopped,
    tab,
    zoom
  } = props
  const hostPlatform = useOptionalHostProtocolGates()?.hostPlatform
  // Only the blank tab + just made takes the keyboard; coming back to a blank tab later doesn't.
  const addressFocus = useNewBrowserTabAddressFocus(tab.browserPageId)
  const typing = useMobileBrowserLiveTyping({ disabled: controlsDisabled, pageInput })
  // While typing, a tap on the page (the next field, say) keeps the keyboard up.
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  const loadFailure = useMobileBrowserLoadFailure({
    loadError: tab.loadError,
    certificateFailure: tab.certificateFailure,
    browserPageId: tab.browserPageId,
    certificateTrustSupported,
    onProceedCertificate: proceedCertificate
  })
  const menuGroups = useMobileBrowserPageMenu({
    url: tab.url,
    canGoForward: tab.canGoForward,
    controlsDisabled,
    browserViewMode,
    selectBrowserViewMode,
    goForward,
    proceedUnsafe: loadFailure?.proceedUnsafe ?? null,
    onToast
  })
  return (
    <View ref={setRootViewRef} style={styles.root}>
      <View
        ref={typing.focused ? keepsKeyboard : undefined}
        style={styles.viewport}
        onLayout={(event) => {
          const next = {
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height
          }
          const current = layoutRef.current
          if (current && current.width === next.width && current.height === next.height) {
            return
          }
          layoutRef.current = next
          setLayout(next)
        }}
        {...panResponder.panHandlers}
      >
        {renderedFrameSource ? (
          <View style={styles.browserImageHost}>
            {frameGeometry ? (
              <View
                pointerEvents="none"
                style={[
                  styles.browserZoomOffset,
                  {
                    width: frameGeometry.renderedWidth,
                    height: frameGeometry.renderedHeight,
                    transform: [{ translateX: zoom.offsetX }, { translateY: zoom.offsetY }]
                  }
                ]}
              >
                <View
                  style={[
                    styles.browserFrameBox,
                    {
                      width: frameGeometry.renderedWidth,
                      height: frameGeometry.renderedHeight,
                      transform: [{ scale: zoom.scale }]
                    }
                  ]}
                >
                  {([0, 1] as const).map((layer) => (
                    <View
                      key={layer}
                      ref={frameLayers[layer].attachView}
                      pointerEvents="none"
                      style={
                        layer === 0
                          ? styles.browserImageLayer
                          : [styles.browserImageLayer, styles.browserImageLayerHidden]
                      }
                    >
                      <Image
                        ref={frameLayers[layer].attachImage}
                        source={renderedFrameSource}
                        resizeMode="stretch"
                        fadeDuration={0}
                        onLoad={frameLayers[layer].onLoad}
                        onError={frameLayers[layer].onError}
                        style={[
                          styles.browserImage,
                          {
                            width: frameGeometry.renderedWidth,
                            height: frameGeometry.renderedHeight
                          }
                        ]}
                      />
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              ([0, 1] as const).map((layer) => (
                <View
                  key={layer}
                  ref={frameLayers[layer].attachView}
                  pointerEvents="none"
                  style={
                    layer === 0
                      ? styles.browserImageLayer
                      : [styles.browserImageLayer, styles.browserImageLayerHidden]
                  }
                >
                  <Image
                    ref={frameLayers[layer].attachImage}
                    source={renderedFrameSource}
                    resizeMode="contain"
                    fadeDuration={0}
                    onLoad={frameLayers[layer].onLoad}
                    onError={frameLayers[layer].onError}
                    style={styles.browserImageFill}
                  />
                </View>
              ))
            )}
          </View>
        ) : null}
        {loadFailure ? (
          <MobileBrowserLoadFailure
            failure={loadFailure}
            retryDisabled={controlsDisabled}
            onRetry={retryFailedLoad}
            // The sign-in sheet has no ⋯, so its way past a certificate warning stays beside Retry.
            showProceedUnsafe={bare}
          />
        ) : null}
        {!renderedFrameSource || busy || error || streamStopped ? (
          <View pointerEvents={streamStopped ? 'box-none' : 'none'} style={styles.overlay}>
            {/* Key busy indicator on received pixels, not ready status: ready streams may send no frames. */}
            {busy || (!renderedFrameSource && !error && !streamStopped) ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : null}
            {streamStopped ? (
              <View style={styles.streamStopped}>
                <Text style={styles.streamStoppedText}>{streamStopped}</Text>
                <MobileStateButton
                  inRow
                  label={t('browser.paneView.reconnect', 'Reconnect')}
                  onPress={reconnectStream}
                />
              </View>
            ) : error ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : null}
          </View>
        ) : null}
        {pageOverlay}
      </View>

      <MobileBrowserBottomBar
        bare={bare}
        url={tab.url}
        canGoBack={tab.canGoBack}
        loading={tab.loading}
        loadFailed={tab.loadError != null}
        bottomInset={bottomInset}
        keyboardLift={keyboardLift}
        controlsDisabled={controlsDisabled}
        addressValue={addressValue}
        addressFocused={addressFocused}
        setAddressValue={setAddressValue}
        setAddressFocused={(focused) => {
          setAddressFocused(focused)
          if (focused) {
            addressFocus.done()
          }
        }}
        focusWhenReady={addressFocus.pending}
        navigateToAddress={() => void navigateToAddress()}
        showStop={showStop}
        stopPage={stopPage}
        reloadPage={reloadPage}
        goBack={goBack}
        onKeyboard={typing.focus}
        menuGroups={menuGroups}
      />
      <TextInput
        {...typing.inputProps}
        style={styles.liveInput}
        accessibilityLabel={t('browser.bottomBar.typeOnPage', 'Type on page')}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        caretHidden
        blurOnSubmit={false}
        editable={!controlsDisabled}
      />
      {typing.focused ? (
        <MobileBrowserPageKeys
          bottomInset={bottomInset}
          keyboardLift={keyboardLift}
          hostPlatform={hostPlatform}
          onKey={typing.pressKey}
          onDone={typing.blur}
        />
      ) : null}
      <MobileBrowserJavaScriptDialog dialog={dialog} sendDialogCommand={sendDialogCommand} />
      <MobileBrowserPagePrompt prompt={dialog ? null : pagePrompt} answer={answerPagePrompt} />
    </View>
  )
}
