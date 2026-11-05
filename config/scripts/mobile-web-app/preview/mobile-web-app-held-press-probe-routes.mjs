export const REPEAT_KEY_LABEL = 'Arrow Up'
export const TAP_KEY_LABEL = 'Escape'

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
  globalThis.__orcaHeldPressProbe = {
    sent: () => [...sentRef.current],
    deliveries: () => [...deliveriesRef.current],
    repeats: () => [...repeatRef.current],
    activeHandle,
    switchTerminal: () => setActiveHandle('other-terminal')
  }
  const controller = {
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    liveInputCapture: '',
    activeHandle,
    activeSessionTab: null,
    dockKeys,
    liveInputRef,
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
    showNativeChat: false,
    dictation: IDLE,
    cancelDictation: noop,
    handleDictationToggle: noop,
    handleDictationPressIn: noop,
    handleDictationPressOut: noop,
    toggleDisplayMode: noop,
    handleAccessoryKey: send,
    dismissSoftwareKeyboard: noop,
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
  return <MobileSessionCommandDock controller={controller} />
}
`
}
