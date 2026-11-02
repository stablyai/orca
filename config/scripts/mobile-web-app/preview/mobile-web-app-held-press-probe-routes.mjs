// Mount shipped held-press surfaces with counting callbacks; Android WebView long-press must not end responder early.

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

export const ARROW_PAD_LABEL = 'Arrow keys'
export const TAP_KEY_LABEL = 'Send Escape'

export function commandDockProbeRouteSource({
  commandDockModule,
  keyDefinitionsModule,
  accessorySelectionModule,
  dockKeysModule
}) {
  return `import { useLayoutEffect, useRef, useState } from 'react'
import { MobileSessionCommandDock } from ${JSON.stringify(commandDockModule)}
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS } from ${JSON.stringify(keyDefinitionsModule)}
import { useMobileSessionAccessorySelection } from ${JSON.stringify(accessorySelectionModule)}
import { useTerminalDockKeys } from ${JSON.stringify(dockKeysModule)}

const noop = () => {}
const KEYS = TERMINAL_ACCESSORY_KEY_DEFINITIONS
const IDLE = { isStarting: false, isRecording: false, isProcessing: false }

export default function CommandDockProbeRoute() {
  const sentRef = useRef([])
  const deliveriesRef = useRef([])
  const repeatRef = useRef([])
  const [activeHandle, setActiveHandle] = useState('held-press-terminal')
  const activeHandleRef = useRef(activeHandle)
  const clientRef = useRef({
    getGeneration: () => 1,
    sendRequest: () => Promise.resolve({ id: 'settings', ok: false, error: { code: 'unavailable' } })
  })
  const connStateRef = useRef('connected')
  const activeSessionTabTypeRef = useRef('terminal')
  useLayoutEffect(() => { activeHandleRef.current = activeHandle }, [activeHandle])
  const send = (input, target = activeHandleRef.current, isCurrent = () => true) => {
    if (!isCurrent()) return Promise.resolve(false)
    sentRef.current.push(input.bytes)
    deliveriesRef.current.push({ bytes: input.bytes, target })
    return Promise.resolve(true)
  }
  const accessory = useMobileSessionAccessorySelection({
    client: clientRef.current,
    clientRef,
    connState: 'connected',
    connStateRef,
    activeHandle,
    activeHandleRef,
    activeSessionTabTypeRef,
    worktreeId: 'held-press-workspace',
    handleAccessoryKey: send
  })
  const dockKeys = useTerminalDockKeys({ activeHandle, sendInput: send })
  const liveInputRef = useRef(null)
  const commandInputRef = useRef(null)
  globalThis.__orcaHeldPressProbe = {
    sent: () => [...sentRef.current],
    deliveries: () => [...deliveriesRef.current],
    repeats: () => [...repeatRef.current],
    activeHandle,
    switchTerminal: () => setActiveHandle('other-terminal')
  }
  const controller = {
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferedTerminalDraftState: { input: '', setInput: noop },
    autocompleteEnabled: false,
    liveInputCapture: '',
    activeHandle,
    activeSessionTab: null,
    dockKeys,
    liveInputRef,
    commandInputRef,
    commandFieldAnchorRef: { current: null },
    commandDictationPreview: null,
    liveDictationText: '',
    customKeys: [],
    setShowCustomKeyModal: noop,
    setDeleteKeyTarget: noop,
    visibleBuiltInAccessoryKeys: KEYS,
    terminalModes: new Map(),
    canPaste: false,
    dictationMode: 'toggle',
    handleLiveInputChange: noop,
    handleLiveInputKeyPress: noop,
    bindLiveInputField: noop,
    submitLiveInput: noop,
    canSend: true,
    canCompose: true,
    liveInputEnabled: false,
    showNativeChat: false,
    dictation: IDLE,
    cancelDictation: noop,
    handleDictationToggle: noop,
    handleDictationPressIn: noop,
    handleDictationPressOut: noop,
    toggleDisplayMode: noop,
    handleSend: () => Promise.resolve(),
    handleAccessoryKey: send,
    dismissSoftwareKeyboard: noop,
    toggleLiveInput: noop,
    stopAccessoryRepeat: () => {
      repeatRef.current.push({ kind: 'stop' })
      accessory.stopAccessoryRepeat()
    },
    cancelAccessoryRepeat: accessory.cancelAccessoryRepeat,
    prepareAccessoryPress: (input) => {
      const press = accessory.prepareAccessoryPress(input)
      return {
        tap: press.tap,
        hold: (firstRepeatDelayMs) => {
          repeatRef.current.push({ kind: 'start', bytes: input.bytes })
          press.hold(firstRepeatDelayMs)
        }
      }
    },
    handlePaste: () => Promise.resolve(),
    isAttaching: false,
    attachImage: () => Promise.resolve(),
    activeMarkdownTab: null,
    activeFileTab: null,
    activeBrowserTab: null,
    keyboardLift: 0
  }
  return <MobileSessionCommandDock controller={controller} keysInRail={false} />
}
`
}

export const BROWSER_VIEWPORT_ID = 'held-press-browser-viewport'

// Real interactions hook owns 550ms right-click; record host request rather than trusting hook toast.
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
  const requestsRef = useRef([])
  const clientRef = useRef({
    sendRequest: (method, params) => {
      requestsRef.current.push({ method, params })
      return Promise.resolve({ ok: true, id: String(requestsRef.current.length), result: {} })
    }
  })
  const layoutRef = useRef(LAYOUT)
  const longPressTimerRef = useRef(null)
  const zoom = { scale: 1, offsetX: 0, offsetY: 0 }
  const [dialog, setDialog] = useState(null)
  const dialogRef = useRef(null)
  dialogRef.current = dialog
  const frameGeometry = computeBrowserFrameGeometry(LAYOUT, null)
  const interactions = useMobileBrowserInteractions({
    clearLongPressTimer: () => clearTimeout(longPressTimerRef.current),
    client: clientRef.current,
    dialogRef,
    frameGeometry,
    frameMetadataRef: { current: null },
    keyboardValue: '',
    layoutRef,
    longPressTimerRef,
    onToast: (message) => toastsRef.current.push(message),
    pageParams: () => ({ worktree: 'held-press-worktree', page: TAB.browserPageId }),
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
    toasts: () => [...toastsRef.current],
    requests: () => [...requestsRef.current]
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
