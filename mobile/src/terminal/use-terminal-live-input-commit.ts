import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  getTerminalLiveSpecialKeyDecision,
  getTerminalLiveSubmitSequence,
  getTerminalLiveTextChangeDecision
} from './terminal-live-text-commit'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import {
  useTerminalLiveAccessoryInputCommit,
  type TerminalLiveAccessoryInput,
  type TerminalLiveInputSender
} from './use-terminal-live-accessory-input-commit'

type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: {
    readonly key: string
  }
}

type TerminalLiveInputCommitOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type TerminalLiveInputCommitHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly handleLiveInputAccessoryBytes: (input: TerminalLiveAccessoryInput) => Promise<boolean>
  readonly handleLiveInputChange: (text: string) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputSubmit: () => void
}

export function useTerminalLiveInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  liveInputRef,
  liveInputTerminalHandles,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLiveInputCommitOptions<TTabType>): TerminalLiveInputCommitHandlers {
  const liveInputCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLiveInputTextRef = useRef('')
  const pendingLiveInputHandleRef = useRef<string | null>(null)

  const clearPendingLiveInputCommit = useCallback(() => {
    if (liveInputCommitTimerRef.current) {
      clearTimeout(liveInputCommitTimerRef.current)
      liveInputCommitTimerRef.current = null
    }
    pendingLiveInputTextRef.current = ''
    pendingLiveInputHandleRef.current = null
    setLiveInputCapture('')
    liveInputRef.current?.setNativeProps({ text: '' })
  }, [liveInputRef, setLiveInputCapture])

  const flushPendingLiveInputText = useCallback(
    async (expectedHandle: string | null): Promise<boolean> => {
      if (liveInputCommitTimerRef.current) {
        clearTimeout(liveInputCommitTimerRef.current)
        liveInputCommitTimerRef.current = null
      }

      const handle = pendingLiveInputHandleRef.current
      const text = pendingLiveInputTextRef.current
      pendingLiveInputHandleRef.current = null
      pendingLiveInputTextRef.current = ''
      setLiveInputCapture('')
      liveInputRef.current?.setNativeProps({ text: '' })

      if (
        !handle ||
        text.length === 0 ||
        (expectedHandle !== null && handle !== expectedHandle) ||
        handle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal' ||
        !liveInputTerminalHandlesRef.current.has(handle)
      ) {
        return false
      }

      return sendLiveTerminalInputRef.current(handle, text)
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      liveInputRef,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture
    ]
  )

  const schedulePendingLiveInputCommit = useCallback(
    (handle: string, text: string, delayMs: number) => {
      if (liveInputCommitTimerRef.current) {
        clearTimeout(liveInputCommitTimerRef.current)
      }
      pendingLiveInputHandleRef.current = handle
      pendingLiveInputTextRef.current = text
      liveInputCommitTimerRef.current = setTimeout(() => {
        liveInputCommitTimerRef.current = null
        void flushPendingLiveInputText(handle)
      }, delayMs)
    },
    [flushPendingLiveInputText]
  )

  useEffect(() => {
    return () => {
      if (liveInputCommitTimerRef.current) {
        clearTimeout(liveInputCommitTimerRef.current)
        liveInputCommitTimerRef.current = null
      }
      pendingLiveInputHandleRef.current = null
      pendingLiveInputTextRef.current = ''
    }
  }, [])

  useEffect(() => {
    const pendingHandle = pendingLiveInputHandleRef.current
    if (!pendingHandle) {
      return
    }
    if (
      !activeHandle ||
      pendingHandle !== activeHandle ||
      activeSessionTabType !== 'terminal' ||
      !liveInputTerminalHandles.has(activeHandle)
    ) {
      clearPendingLiveInputCommit()
    }
  }, [activeHandle, activeSessionTabType, clearPendingLiveInputCommit, liveInputTerminalHandles])

  const handleLiveInputChange = useCallback(
    (text: string) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      const normalizedText = normalizeTerminalTextInput(text)
      const decision = getTerminalLiveTextChangeDecision(normalizedText)
      switch (decision.kind) {
        case 'ignore':
          clearPendingLiveInputCommit()
          return
        case 'send-now':
          clearPendingLiveInputCommit()
          void sendLiveTerminalInputRef.current(activeHandle, decision.text)
          return
        case 'defer':
          // Why: React Native does not expose composition events here, so keep
          // probable IME text in the native field until the commit timer settles.
          setLiveInputCapture(decision.text)
          schedulePendingLiveInputCommit(activeHandle, decision.text, decision.delayMs)
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      clearPendingLiveInputCommit,
      liveInputTerminalHandles,
      schedulePendingLiveInputCommit,
      sendLiveTerminalInputRef,
      setLiveInputCapture
    ]
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const pendingText =
        pendingLiveInputHandleRef.current === activeHandle ? pendingLiveInputTextRef.current : ''
      if (pendingLiveInputHandleRef.current && pendingLiveInputHandleRef.current !== activeHandle) {
        clearPendingLiveInputCommit()
      }
      const decision = getTerminalLiveSpecialKeyDecision({
        key: event.nativeEvent.key,
        pendingText
      })
      switch (decision.kind) {
        case 'ignore':
        case 'local-edit':
          return
        case 'send-now':
          void sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          clearPendingLiveInputCommit()
          return
        case 'flush-then-send':
          void sendTerminalLiveControlAfterPendingFlush(
            () => flushPendingLiveInputText(activeHandle),
            () => sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      liveInputTerminalHandles,
      sendLiveTerminalInputRef
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    liveInputRef,
    liveInputTerminalHandles,
    pendingLiveInputHandleRef,
    pendingLiveInputTextRef,
    schedulePendingLiveInputCommit,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })

  const handleLiveInputSubmit = useCallback(() => {
    if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
      return
    }
    const pendingText =
      pendingLiveInputHandleRef.current === activeHandle ? pendingLiveInputTextRef.current : ''
    const sequence = getTerminalLiveSubmitSequence(pendingText)
    if (sequence.length === 2) {
      void sendTerminalLiveControlAfterPendingFlush(
        () => flushPendingLiveInputText(activeHandle),
        () => sendLiveTerminalInputRef.current(activeHandle, sequence[1])
      )
      return
    }
    clearPendingLiveInputCommit()
    void sendLiveTerminalInputRef.current(activeHandle, sequence[0])
  }, [
    activeHandle,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    liveInputTerminalHandles,
    sendLiveTerminalInputRef
  ])

  return {
    clearPendingLiveInputCommit,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit
  }
}
