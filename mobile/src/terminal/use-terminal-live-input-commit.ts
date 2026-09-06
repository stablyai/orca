import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  mapTerminalLiveHardwareKeyEvent,
  type TerminalLiveHardwareKeyEvent
} from './terminal-live-hardware-key-mapping'
import { getTerminalLiveSpecialKeyDecision } from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type {
  TerminalLiveInputSender,
  TerminalLiveExternalSend
} from './terminal-live-input-sender'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import { useTerminalNativeFieldBoundary } from './use-terminal-native-field-boundary'
import type {
  TerminalLiveInputChangeEvent,
  TerminalLiveInputKeyPressEvent
} from './terminal-live-input-events'
import {
  useTerminalLiveAccessoryInputCommit,
  type TerminalLiveAccessoryInputCommitResult
} from './use-terminal-live-accessory-input-commit'

type TerminalLiveInputCommitOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly connected: boolean
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type TerminalLiveInputCommitHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputBeforeExternalSend: TerminalLiveExternalSend
  readonly getLiveInputInteractionGeneration: () => number
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputChange: (event: TerminalLiveInputChangeEvent) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputHardwareKey: (event: TerminalLiveHardwareKeyEvent) => void
  readonly handleLiveInputSubmit: () => Promise<boolean>
}

export function useTerminalLiveInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  connected,
  liveInputRef,
  liveInputTerminalHandles,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLiveInputCommitOptions<TTabType>): TerminalLiveInputCommitHandlers {
  const liveInputInteractionGenerationRef = useRef(0)
  const advanceLiveInputInteractionGeneration = useCallback(() => {
    liveInputInteractionGenerationRef.current += 1
  }, [])
  const {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    queueLiveInputControl,
    heldLiveInputTextRef,
    liveInputComposingRef,
    pendingLiveInputHandleRef,
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  } = useTerminalLivePendingInputFlush({
    activeHandleRef,
    activeSessionTabTypeRef,
    liveInputRef,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })

  useEffect(() => {
    // Why: what reached the PTY is unknowable across an outage — stale mirror state corrupts the first post-reconnect send.
    if (!connected) {
      clearPendingLiveInputCommit()
    }
  }, [connected, clearPendingLiveInputCommit])

  useEffect(() => {
    const pendingHandle = pendingLiveInputHandleRef.current
    if (!pendingHandle) {
      return
    }
    // Why: a lagging mobile tab list briefly yields no active tab object; a
    // null/undefined type is "unknown", not "left the terminal" — flush guards
    // still block sends if the tab truly changed.
    if (
      !activeHandle ||
      pendingHandle !== activeHandle ||
      (activeSessionTabType != null && activeSessionTabType !== 'terminal') ||
      !liveInputTerminalHandles.has(activeHandle)
    ) {
      clearPendingLiveInputCommit()
    }
  }, [activeHandle, activeSessionTabType, clearPendingLiveInputCommit, liveInputTerminalHandles])

  const { nativeFieldBoundaryRef, acceptNativeFieldBoundary } = useTerminalNativeFieldBoundary(
    connected,
    activeHandle,
    liveInputTerminalHandles,
    applyLiveInputMirror
  )

  const flushPendingLiveInputBeforeExternalSend = useCallback<TerminalLiveExternalSend>(
    async (handle, send, retainedText = '', options): Promise<boolean> => {
      if (
        options?.fieldBoundary &&
        (handle !== activeHandle || !acceptNativeFieldBoundary(options.fieldBoundary))
      ) {
        return false
      }
      advanceLiveInputInteractionGeneration()
      if (send) {
        return queueLiveInputControl(handle, retainedText, send, {
          ...options,
          nativeFieldReset: options?.fieldBoundary != null || options?.nativeFieldReset
        })
      }
      const pendingHandle = pendingLiveInputHandleRef.current
      if (pendingHandle && pendingHandle !== handle) {
        clearPendingLiveInputCommit()
        return waitForPendingLiveInputFlush()
      }
      // Why: external bytes (dictation/paste) land after the field's echo on the
      // PTY; the field session must fully end or later diffs would erase them.
      if (pendingHandle === handle) {
        return flushPendingLiveInputText(handle)
      }
      return waitForPendingLiveInputFlush()
    },
    [
      activeHandle,
      acceptNativeFieldBoundary,
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      waitForPendingLiveInputFlush,
      queueLiveInputControl
    ]
  )

  const handleLiveInputChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputChangeEvent) => {
      const boundary = nativeFieldBoundaryRef.current
      if (
        boundary &&
        nativeEvent.target === boundary.target &&
        nativeEvent.eventCount != null &&
        nativeEvent.eventCount <= boundary.eventCount
      ) {
        return
      }
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      // Why: iOS kills an active dictation/IME session when JS writes a value
      // that differs from the native field text, so the controlled capture must
      // echo the field verbatim; only the PTY mirror sees normalized text.
      advanceLiveInputInteractionGeneration()
      setLiveInputCapture(nativeEvent.text)
      void applyLiveInputMirror(
        activeHandle,
        normalizeTerminalTextInput(nativeEvent.text),
        nativeEvent.isComposing
      )
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      liveInputTerminalHandles,
      setLiveInputCapture
    ]
  )

  const getLiveInputInteractionGeneration = useCallback(
    () => liveInputInteractionGenerationRef.current,
    []
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      advanceLiveInputInteractionGeneration()
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const decision = getTerminalLiveSpecialKeyDecision({
        key: event.nativeEvent.key,
        heldText: ownsPendingState ? heldLiveInputTextRef.current : '',
        sentText: ownsPendingState ? sentLiveInputTextRef.current : ''
      })
      switch (decision.kind) {
        case 'ignore':
        case 'local-edit':
          return
        case 'send-now':
        case 'commit-held-then-send':
          void queueLiveInputControl(activeHandle, decision.bytes)
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      liveInputTerminalHandles,
      sendLiveTerminalInputRef,
      waitForPendingLiveInputFlush,
      queueLiveInputControl
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    queueLiveInputControl,
    heldLiveInputTextRef,
    liveInputComposingRef,
    liveInputRef,
    liveInputTerminalHandles,
    onInteraction: advanceLiveInputInteractionGeneration,
    pendingLiveInputHandleRef,
    sentLiveInputTextRef,
    setLiveInputCapture,
    waitForPendingLiveInputFlush
  })

  const handleLiveInputSubmit = useCallback((): Promise<boolean> => {
    if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
      return Promise.resolve(false)
    }
    advanceLiveInputInteractionGeneration()
    return queueLiveInputControl(activeHandle, '\r')
  }, [
    activeHandle,
    advanceLiveInputInteractionGeneration,
    queueLiveInputControl,
    liveInputTerminalHandles,
    sendLiveTerminalInputRef
  ])

  const handleLiveInputHardwareKey = useCallback(
    (event: TerminalLiveHardwareKeyEvent) => {
      if (!connected || !activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const boundary = event.fieldBoundary
      if (!acceptNativeFieldBoundary(boundary)) {
        return
      }
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      const decision = mapTerminalLiveHardwareKeyEvent(event, {
        heldText: ownsPendingState ? heldLiveInputTextRef.current : '',
        sentText: ownsPendingState ? sentLiveInputTextRef.current : ''
      })
      if (decision.kind === 'ignore') {
        if (boundary) {
          void queueLiveInputControl(activeHandle, '', async () => true, { nativeFieldReset: true })
        }
        return
      }
      if (decision.kind === 'local-edit') {
        void handleLiveInputAccessoryBytes({
          bytes: '',
          localEdit: decision.localEdit
        })
        return
      }
      advanceLiveInputInteractionGeneration()
      // Physical controls end the mirror baseline and share the existing send barrier.
      void queueLiveInputControl(activeHandle, decision.bytes, undefined, {
        nativeFieldReset: boundary != null
      })
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      connected,
      acceptNativeFieldBoundary,
      queueLiveInputControl,
      handleLiveInputAccessoryBytes,
      liveInputTerminalHandles,
      sendLiveTerminalInputRef
    ]
  )

  return {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    getLiveInputInteractionGeneration,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputHardwareKey,
    handleLiveInputSubmit
  }
}
