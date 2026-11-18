import type { Dispatch, RefObject, SetStateAction } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  Text,
  View,
  type PanResponderInstance,
  type StyleProp,
  type ViewStyle,
  type HostInstance
} from 'react-native'
import { ArrowUp, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, pressedStyle } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBrowserAddressField } from './MobileBrowserAddressField'
import {
  MobileBrowserDrawingButtons,
  type MobileBrowserStreamedDrawing
} from '../MobileBrowserDrawingButtons'
import { MobileBrowserJavaScriptDialog } from './MobileBrowserJavaScriptDialog'
import { MobileBrowserKeyRow } from './MobileBrowserKeyRow'
import { MobileBrowserLoadFailure } from './MobileBrowserLoadFailure'
import {
  MobileBrowserPointerModifiers,
  type BrowserPointerModifier
} from './MobileBrowserPointerModifiers'
import { MobileBrowserToolbarIconButton } from './MobileBrowserToolbarIconButton'
import { MobileBrowserViewModeSwitch } from './MobileBrowserViewModeSwitch'
import { buttonColor } from '../screencast/mobile-browser-frame-state'
import { mobileBrowserPaneStyles as styles } from './mobile-browser-pane-styles'
import type { BrowserFrameLayerBinding } from '../screencast/browser-frame-pacer'
import type {
  BrowserFrameGeometry,
  BrowserTouchLayout,
  BrowserZoomState
} from '../page-interaction/browser-touch-geometry'
import type { MobileBrowserViewMode } from '../screencast/browser-screencast-request-parameters'
import type { MobileBrowserTab } from '../../session/tabs/mobile-session-tabs'
import type { BrowserDialogState } from '../screencast/mobile-browser-stream-events'
import { FieldTextInput } from '../../components/composer-input/FieldTextInput'
import type { MobileCertificateProceedFailure } from '../certificate/mobile-browser-certificate-proceed'

// Why: seeds layer 0 as the visible one; the pacer owns opacity after mount, so a render must not.
const FRAME_LAYER_STYLES: [StyleProp<ViewStyle>, StyleProp<ViewStyle>] = [
  styles.browserImageLayer,
  [styles.browserImageLayer, styles.browserImageLayerHidden]
]

type MobileBrowserPaneViewProps = {
  addressFocused: boolean
  addressValue: string
  bottomInset: number
  browserViewMode: MobileBrowserViewMode
  busy: boolean
  certificateTrustSupported: boolean
  controlsDisabled: boolean
  dialog: BrowserDialogState | null
  error: string | null
  frameGeometry: BrowserFrameGeometry | null
  frameLayers: readonly [BrowserFrameLayerBinding, BrowserFrameLayerBinding]
  goBack: () => void
  goForward: () => void
  keyboardLift: number
  keyboardValue: string
  layoutRef: RefObject<BrowserTouchLayout | null>
  navigateToAddress: () => Promise<void>
  drawing?: MobileBrowserStreamedDrawing
  panResponder: PanResponderInstance
  proceedCertificate: (challengeId: string) => Promise<MobileCertificateProceedFailure | null>
  pointerModifiers: BrowserPointerModifier[]
  reloadPage: () => void
  retryFailedLoad: () => void
  renderedFrameSource: { uri: string } | null
  selectBrowserViewMode: (mode: MobileBrowserViewMode) => void
  sendDialogCommand: (
    method: 'browser.dialogDismiss' | 'browser.dialogAccept',
    promptText?: string
  ) => Promise<void>
  sendKeyboardText: () => Promise<void>
  sendKeypress: (key: string) => Promise<void>
  setAddressFocused: Dispatch<SetStateAction<boolean>>
  setAddressValue: Dispatch<SetStateAction<string>>
  setKeyboardValue: Dispatch<SetStateAction<string>>
  setLayout: Dispatch<SetStateAction<BrowserTouchLayout | null>>
  setRootViewRef: (view: HostInstance | null) => void
  tab: MobileBrowserTab
  togglePointerModifier: (modifier: BrowserPointerModifier) => void
  zoom: BrowserZoomState
}

// Frame cap can leave viewport unpainted despite live stream; oversized frames are dropped, never fatal.
// Area budget prevents starvation: C6.6 with budget disabled measured 299 dropped/6 applied and a persistent spinner.
export function MobileBrowserPaneView(props: MobileBrowserPaneViewProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const {
    addressFocused,
    addressValue,
    bottomInset,
    browserViewMode,
    busy,
    certificateTrustSupported,
    controlsDisabled,
    dialog,
    error,
    frameGeometry,
    frameLayers,
    goBack,
    goForward,
    keyboardLift,
    keyboardValue,
    layoutRef,
    navigateToAddress,
    drawing,
    panResponder,
    pointerModifiers,
    proceedCertificate,
    reloadPage,
    retryFailedLoad,
    renderedFrameSource,
    selectBrowserViewMode,
    sendDialogCommand,
    sendKeyboardText,
    sendKeypress,
    setAddressFocused,
    setAddressValue,
    setKeyboardValue,
    setLayout,
    setRootViewRef,
    tab,
    togglePointerModifier,
    zoom
  } = props
  return (
    <View ref={setRootViewRef} style={styles.root}>
      <View style={styles.toolbar}>
        <MobileBrowserToolbarIconButton
          disabled={controlsDisabled || !tab.canGoBack}
          label={t('common.back', 'Back')}
          onPress={goBack}
        >
          <ChevronLeft size={15} color={buttonColor(!controlsDisabled && tab.canGoBack)} />
        </MobileBrowserToolbarIconButton>
        <MobileBrowserToolbarIconButton
          disabled={controlsDisabled || !tab.canGoForward}
          label={t('browser.paneView.forward', 'Forward')}
          onPress={goForward}
        >
          <ChevronRight size={15} color={buttonColor(!controlsDisabled && tab.canGoForward)} />
        </MobileBrowserToolbarIconButton>
        <MobileBrowserToolbarIconButton
          disabled={controlsDisabled}
          label={t('browser.paneView.reload', 'Reload')}
          onPress={reloadPage}
        >
          <RefreshCw size={15} color={buttonColor(!controlsDisabled)} />
        </MobileBrowserToolbarIconButton>
        <MobileBrowserAddressField
          value={addressValue}
          onChangeText={setAddressValue}
          onFocus={() => setAddressFocused(true)}
          onBlur={() => setAddressFocused(false)}
          onSubmit={() => void navigateToAddress()}
          focused={addressFocused}
          disabled={controlsDisabled}
          loading={tab.loading}
          loadFailed={tab.loadError != null}
        />
        <MobileBrowserViewModeSwitch
          disabled={controlsDisabled}
          value={browserViewMode}
          onChange={selectBrowserViewMode}
        />
        {drawing && (
          <MobileBrowserDrawingButtons
            drawing="stream"
            onDrawingChange={drawing.onDrawingChange}
            fullScreen={drawing.fullScreen}
          />
        )}
      </View>

      <View
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
                      style={FRAME_LAYER_STYLES[layer]}
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
                  style={FRAME_LAYER_STYLES[layer]}
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
        {tab.loadError ? (
          <MobileBrowserLoadFailure
            loadError={tab.loadError}
            certificateFailure={tab.certificateFailure}
            browserPageId={tab.browserPageId}
            certificateTrustSupported={certificateTrustSupported}
            retryDisabled={controlsDisabled}
            onRetry={retryFailedLoad}
            onProceedCertificate={proceedCertificate}
          />
        ) : null}
        {!renderedFrameSource || busy || error ? (
          <View pointerEvents="none" style={styles.overlay}>
            {/* Key busy indicator on received pixels, not ready status: ready streams may send no frames. */}
            {busy || (!renderedFrameSource && !error) ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : null}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>
        ) : null}
        {dialog ? (
          <MobileBrowserJavaScriptDialog
            key={dialog.occurrence}
            dialog={dialog}
            keyboardLift={keyboardLift}
            sendDialogCommand={sendDialogCommand}
          />
        ) : null}
      </View>

      <View
        style={[
          styles.keyboardDock,
          { paddingBottom: bottomInset, transform: [{ translateY: -keyboardLift }] }
        ]}
      >
        <MobileBrowserPointerModifiers
          disabled={controlsDisabled}
          selectedModifiers={pointerModifiers}
          onToggle={togglePointerModifier}
        />
        <MobileBrowserKeyRow
          disabled={controlsDisabled}
          onKeypress={(key) => void sendKeypress(key)}
        />
        <View style={styles.inputRow}>
          <FieldTextInput
            style={styles.keyboardInput}
            value={keyboardValue}
            onChangeText={setKeyboardValue}
            placeholder={t('browser.paneView.keyboardPlaceholder', 'Type on page…')}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!controlsDisabled}
            onSubmitEditing={() => void sendKeyboardText()}
          />
          <Pressable
            style={({ pressed }) => [
              styles.sendButton,
              (controlsDisabled || !keyboardValue) && styles.disabled,
              pressed && pressedStyle
            ]}
            disabled={controlsDisabled || !keyboardValue}
            onPress={() => void sendKeyboardText()}
            accessibilityLabel={t('browser.paneView.sendText', 'Send text to browser')}
          >
            <ArrowUp size={18} color={buttonColor(!controlsDisabled && !!keyboardValue)} />
          </Pressable>
        </View>
      </View>
    </View>
  )
}
