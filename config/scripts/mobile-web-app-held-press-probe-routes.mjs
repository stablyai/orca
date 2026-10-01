/**
 * Scratch routes for the held-press check: the surfaces whose press must outlive Android WebView's
 * long-press. Each mounts the shipped component with stubbed effects; what is under test is the
 * press responder and the touchstart guard, so handlers only count.
 */

/** RN Web renders `nativeID` as the DOM `id`; the check touches each mic through it. */
export const TERMINAL_MIC_ID = 'hold-probe-terminal-mic'
export const CHAT_MIC_ID = 'hold-probe-chat-mic'

export function holdDictationProbeRouteSource({ terminalActionsModule, chatComposerModule }) {
  return `import { useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { MobileTerminalInputActions } from ${JSON.stringify(terminalActionsModule)}
import { MobileNativeChatComposer } from ${JSON.stringify(chatComposerModule)}

const noop = () => {}

export default function HoldDictationProbeRoute() {
  const [terminalHeld, setTerminalHeld] = useState(false)
  const [chatHeld, setChatHeld] = useState(false)
  const pressOutsRef = useRef({ terminal: 0, chat: 0 })
  globalThis.__orcaHeldPressProbe = { pressOuts: () => ({ ...pressOutsRef.current }) }
  return (
    <View style={{ padding: 24, gap: 24 }}>
      <Text>Model</Text>
      <View nativeID=${JSON.stringify(TERMINAL_MIC_ID)} style={{ flexDirection: 'row' }}>
        <MobileTerminalInputActions
          canSend
          isAttaching={false}
          dictation={{ isStarting: false, isRecording: terminalHeld, isProcessing: false }}
          dictationMode="hold"
          buttonStyle={{ width: 48, height: 48 }}
          activeButtonStyle={null}
          disabledButtonStyle={null}
          onAttachImage={noop}
          onAttachFile={noop}
          onDictationToggle={noop}
          onDictationPressIn={() => setTerminalHeld(true)}
          onDictationPressOut={() => {
            pressOutsRef.current.terminal += 1
            setTerminalHeld(false)
          }}
          onDictationCancel={noop}
        />
      </View>
      <View nativeID=${JSON.stringify(CHAT_MIC_ID)}>
        <MobileNativeChatComposer
          value=""
          onChangeText={noop}
          onSend={() => Promise.resolve(false)}
          sendSurfaceId="hold-probe"
          getSendCompletionGeneration={() => 0}
          getComposerEditGeneration={() => 0}
          onMicPress={noop}
          micActive={chatHeld}
          dictationMode="hold"
          onMicPressIn={() => setChatHeld(true)}
          onMicPressOut={() => {
            pressOutsRef.current.chat += 1
            setChatHeld(false)
          }}
        />
      </View>
    </View>
  )
}
`
}

export const REPEAT_KEY_LABEL = 'Arrow Up'
export const TAP_KEY_LABEL = 'Escape'

/**
 * The key bar's built-in keys. The repeat cadence is `use-mobile-session-accessory-selection.ts`'s
 * (send on press-in, repeat after 400 ms, then every 45 ms, stop on press-out), restated here
 * because that hook is bound to the whole session controller.
 */
export function accessoryKeyProbeRouteSource({ accessoryKeyModule, keyDefinitionsModule }) {
  return `import { useRef } from 'react'
import { View } from 'react-native'
import { MobileTerminalAccessoryKey } from ${JSON.stringify(accessoryKeyModule)}
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS } from ${JSON.stringify(keyDefinitionsModule)}

const pick = (id) => TERMINAL_ACCESSORY_KEY_DEFINITIONS.find((key) => key.id === id)

export default function AccessoryKeyProbeRoute() {
  const sentRef = useRef([])
  const timersRef = useRef({ timeout: null, interval: null })
  const stop = () => {
    clearTimeout(timersRef.current.timeout)
    clearInterval(timersRef.current.interval)
  }
  const send = (input) => sentRef.current.push(input.bytes)
  const start = (input) => {
    stop()
    timersRef.current.timeout = setTimeout(() => {
      timersRef.current.interval = setInterval(() => send(input), 45)
    }, 400)
  }
  globalThis.__orcaHeldPressProbe = { sent: () => [...sentRef.current] }
  return (
    <View style={{ padding: 24, flexDirection: 'row', gap: 12 }}>
      {['arrowUp', 'escape'].map((id) => (
        <MobileTerminalAccessoryKey
          key={id}
          accessoryKey={pick(id)}
          canSend
          onSend={send}
          onRepeatStart={start}
          onRepeatStop={stop}
        />
      ))}
    </View>
  )
}
`
}

export const BROWSER_VIEWPORT_ID = 'held-press-browser-viewport'

/**
 * The browser pane's view with its real interactions hook, which owns the 550 ms long-press
 * right-click. A right-click shows as the hook's own "Right click" toast. An init script may set
 * `__orcaHeldPressInitialDialog` to open the pane on a browser dialog.
 */
export function browserPaneProbeRouteSource({
  paneViewModule,
  interactionsModule,
  geometryModule
}) {
  return `import { useRef, useState } from 'react'
import { View } from 'react-native'
import { MobileBrowserPaneView } from ${JSON.stringify(paneViewModule)}
import { useMobileBrowserInteractions } from ${JSON.stringify(interactionsModule)}
import { computeBrowserFrameGeometry } from ${JSON.stringify(geometryModule)}

const noop = () => {}
const LAYOUT = { width: 390, height: 500 }
const LAYER = { attachView: noop, attachImage: noop, onLoad: noop, onError: noop }
const TAB = {
  type: 'browser',
  id: 'held-press-tab',
  title: 'Example',
  browserWorkspaceId: 'held-press-workspace',
  browserPageId: 'held-press-page',
  url: 'https://example.com/',
  loading: false,
  canGoBack: false,
  canGoForward: false
}

export default function BrowserPaneProbeRoute() {
  const toastsRef = useRef([])
  const layoutRef = useRef(LAYOUT)
  const longPressTimerRef = useRef(null)
  const zoom = { scale: 1, offsetX: 0, offsetY: 0 }
  // Seeded before load: a dialog opened from outside a React event is not reliably kept here.
  const [dialog, setDialog] = useState(globalThis.__orcaHeldPressInitialDialog ?? null)
  const dialogRef = useRef(null)
  dialogRef.current = dialog
  const frameGeometry = computeBrowserFrameGeometry(LAYOUT, null)
  const interactions = useMobileBrowserInteractions({
    clearLongPressTimer: () => clearTimeout(longPressTimerRef.current),
    client: null,
    dialogRef,
    frameGeometry,
    frameMetadataRef: { current: null },
    keyboardValue: '',
    layoutRef,
    longPressTimerRef,
    onToast: (message) => toastsRef.current.push(message),
    pageParams: () => null,
    panRef: useRef(null),
    pinchRef: useRef(null),
    pointerModifiers: [],
    sendBrowserRequest: () => Promise.resolve(null),
    scrollingRef: useRef(false),
    startPointRef: useRef(null),
    setDialog,
    setError: noop,
    setKeyboardValue: noop,
    setPointerModifiers: noop,
    setZoom: noop,
    zoomRef: { current: zoom }
  })
  globalThis.__orcaHeldPressProbe = {
    toasts: () => [...toastsRef.current]
  }
  return (
    <View nativeID=${JSON.stringify(BROWSER_VIEWPORT_ID)} style={{ flex: 1 }}>
      <MobileBrowserPaneView
        addressFocused={false}
        addressValue={TAB.url}
        bottomInset={0}
        browserViewMode="mobile"
        busy={false}
        controlsDisabled={false}
        dialog={dialog}
        error={null}
        frameGeometry={frameGeometry}
        frameLayers={[LAYER, LAYER]}
        goBack={noop}
        goForward={noop}
        keyboardLift={0}
        keyboardValue=""
        layoutRef={layoutRef}
        navigateToAddress={() => Promise.resolve()}
        panResponder={interactions.panResponder}
        pointerModifiers={[]}
        reloadPage={noop}
        renderedFrameSource={null}
        selectBrowserViewMode={noop}
        sendDialogCommand={interactions.sendDialogCommand}
        sendKeyboardText={() => Promise.resolve()}
        sendKeypress={() => Promise.resolve()}
        setAddressFocused={noop}
        setAddressValue={noop}
        setKeyboardValue={noop}
        setLayout={noop}
        setRootViewRef={noop}
        tab={TAB}
        togglePointerModifier={noop}
        zoom={zoom}
      />
    </View>
  )
}
`
}
