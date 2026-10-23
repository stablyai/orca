import type { Dispatch, RefObject, SetStateAction } from 'react'
import {
  ActivityIndicator,
  Image,
  Text,
  View,
  type PanResponderInstance,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { MobileBrowserAddressField } from './MobileBrowserAddressField'
import { MobileBrowserLoadFailure } from './MobileBrowserLoadFailure'
import type { BrowserPointerModifier } from './MobileBrowserPointerModifiers'
import { MobileBrowserTypingDock } from './MobileBrowserTypingDock'
import { MobileBrowserViewModeSwitch } from './MobileBrowserViewModeSwitch'
import { mobileBrowserPaneStyles as styles } from './mobile-browser-pane-styles'
import type { BrowserFrameLayerBinding } from './browser-frame-pacer'
import type {
  BrowserFrameGeometry,
  BrowserTouchLayout,
  BrowserZoomState
} from './browser-touch-geometry'
import type { MobileBrowserViewMode } from './browser-screencast-request'
import type { MobileBrowserTab } from './MobileBrowserPane'
import type { BrowserDialogState } from './mobile-browser-stream-events'

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
  panResponder: PanResponderInstance
  pointerModifiers: BrowserPointerModifier[]
  reloadPage: () => void
  renderedFrameSource: { uri: string } | null
  selectBrowserViewMode: (mode: MobileBrowserViewMode) => void
  sendDialogCommand: (method: 'browser.dialogDismiss' | 'browser.dialogAccept') => Promise<void>
  sendKeyboardText: () => Promise<void>
  sendKeypress: (key: string) => Promise<void>
  setAddressFocused: Dispatch<SetStateAction<boolean>>
  setAddressValue: Dispatch<SetStateAction<string>>
  setKeyboardValue: Dispatch<SetStateAction<string>>
  setLayout: Dispatch<SetStateAction<BrowserTouchLayout | null>>
  setRootViewRef: (view: View | null) => void
  tab: MobileBrowserTab
  togglePointerModifier: (modifier: BrowserPointerModifier) => void
  zoom: BrowserZoomState
}

/**
 * The pane's chrome and the surface the frames paint into.
 *
 * "Never dark" holds only for a page that produces some frame that fits: with every frame over the
 * cap this sits on its busy spinner over an unpainted viewport, which the C6.6 device proof
 * measured with the area budget forced off — 299 dropped, 6 applied, the stream alive and no error
 * state, and nothing to look at. That is C6 ruling 1 working as written, not a failure of it: a
 * frame that does not fit is dropped rather than ending the stream. It is what the area budget
 * exists to keep from happening.
 */
export function MobileBrowserPaneView(props: MobileBrowserPaneViewProps) {
  const {
    addressFocused,
    addressValue,
    bottomInset,
    browserViewMode,
    busy,
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
    panResponder,
    pointerModifiers,
    reloadPage,
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
        <IconButton
          icon={ChevronLeft}
          variant="bare"
          iconSize={22}
          disabled={controlsDisabled || !tab.canGoBack}
          onPress={goBack}
          accessibilityLabel="Back"
        />
        <IconButton
          icon={ChevronRight}
          variant="bare"
          iconSize={22}
          disabled={controlsDisabled || !tab.canGoForward}
          onPress={goForward}
          accessibilityLabel="Forward"
        />
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
          trailing={
            <IconButton
              icon={RefreshCw}
              variant="bare"
              iconSize={16}
              iconColor={colors.textSecondary}
              disabled={controlsDisabled}
              onPress={reloadPage}
              accessibilityLabel="Reload"
              style={styles.reload}
            />
          }
        />
        <MobileBrowserViewModeSwitch
          disabled={controlsDisabled}
          value={browserViewMode}
          onChange={selectBrowserViewMode}
        />
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
        {tab.loadError ? <MobileBrowserLoadFailure loadError={tab.loadError} /> : null}
        {!renderedFrameSource || busy || error ? (
          <View pointerEvents="box-none" style={styles.overlay}>
            {/* Why: a stream can report ready and then deliver no frames, so key the
                indicator off actually having pixels or it clears into a blank pane. */}
            {error ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>Can't show this page</Text>
                <Text style={styles.errorText}>{error}</Text>
                {!controlsDisabled ? (
                  <Button label="Try again" size="compact" onPress={reloadPage} />
                ) : null}
              </View>
            ) : busy || !renderedFrameSource ? (
              <View pointerEvents="none" style={styles.loading}>
                <ActivityIndicator size="small" color={colors.textSecondary} />
                {!renderedFrameSource ? (
                  <Text style={styles.loadingText}>Loading page…</Text>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
        {dialog ? (
          <View style={styles.dialogOverlay}>
            <View style={styles.dialogCard} accessibilityRole="alert">
              <Text style={styles.dialogTitle}>This page says</Text>
              <Text style={styles.dialogMessage}>{dialog.message}</Text>
              {/* The page is still blocked, so the buttons stay live and the card says why. */}
              {dialog.error ? <Text style={styles.dialogError}>{dialog.error}</Text> : null}
              <View style={styles.dialogActions}>
                {dialog.dialogType !== 'alert' ? (
                  <Button
                    label="Cancel"
                    size="compact"
                    variant="plain"
                    disabled={dialog.pending !== undefined}
                    onPress={() => void sendDialogCommand('browser.dialogDismiss')}
                  />
                ) : null}
                <Button
                  label="OK"
                  size="compact"
                  variant="primary"
                  disabled={dialog.pending !== undefined}
                  onPress={() => void sendDialogCommand('browser.dialogAccept')}
                />
              </View>
            </View>
          </View>
        ) : null}
      </View>

      <MobileBrowserTypingDock
        bottomInset={bottomInset}
        keyboardLift={keyboardLift}
        controlsDisabled={controlsDisabled}
        pointerModifiers={pointerModifiers}
        togglePointerModifier={togglePointerModifier}
        sendKeypress={sendKeypress}
        keyboardValue={keyboardValue}
        setKeyboardValue={setKeyboardValue}
        sendKeyboardText={sendKeyboardText}
      />
    </View>
  )
}
