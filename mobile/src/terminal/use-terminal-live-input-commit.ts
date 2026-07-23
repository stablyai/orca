import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { getTerminalLiveSpecialKeyDecision } from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import type { TerminalLiveNativeSelection } from './terminal-live-selection-cursor'
import {
  classifyTerminalLiveSelectionEvent,
  isTerminalLiveFieldOwnedArrowKey,
  shouldApplyTerminalLiveCursorOnlySelectionMove
} from './terminal-live-selection-event-routing'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import {
  useTerminalLiveAccessoryInputCommit,
  type TerminalLiveAccessoryInputCommitResult
} from './use-terminal-live-accessory-input-commit'

type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: {
    readonly key: string
  }
}

type TerminalLiveInputSelectionChangeEvent = {
  readonly nativeEvent: {
    readonly selection: TerminalLiveNativeSelection
  }
}

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
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputChange: (text: string) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputSelectionChange: (event: TerminalLiveInputSelectionChangeEvent) => void
  readonly handleLiveInputSubmit: () => void
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
  const {
    applyLiveInputMirror,
    applyLiveInputSelection,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    pendingLiveInputHandleRef,
    queueLiveInputControl,
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

  const rawFieldTextRef = useRef('')
  // Keep the one-shot marker across task boundaries because native text and
  // selection callbacks need not share a JS microtask.
  const expectsPairedSelectionAfterTextChangeRef = useRef(false)

  const resetSelectionSessionLatch = useCallback(() => {
    rawFieldTextRef.current = ''
    expectsPairedSelectionAfterTextChangeRef.current = false
  }, [])

  const clearPendingLiveInputCommitAndSelection = useCallback(() => {
    resetSelectionSessionLatch()
    clearPendingLiveInputCommit()
  }, [clearPendingLiveInputCommit, resetSelectionSessionLatch])

  const flushPendingLiveInputTextAndSelection = useCallback(
    async (expectedHandle: string | null): Promise<boolean> => {
      // External sends end the native field session even when its text is empty.
      resetSelectionSessionLatch()
      return flushPendingLiveInputText(expectedHandle)
    },
    [flushPendingLiveInputText, resetSelectionSessionLatch]
  )

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
      clearPendingLiveInputCommitAndSelection()
    }
  }, [
    activeHandle,
    activeSessionTabType,
    clearPendingLiveInputCommitAndSelection,
    liveInputTerminalHandles
  ])

  const flushPendingLiveInputBeforeExternalSend = useCallback(
    async (handle: string): Promise<boolean> => {
      const pendingHandle = pendingLiveInputHandleRef.current
      if (pendingHandle && pendingHandle !== handle) {
        clearPendingLiveInputCommitAndSelection()
        return waitForPendingLiveInputFlush()
      }
      // Why: external bytes (dictation/paste) land after the field's echo on the
      // PTY; the field session must fully end or later diffs would erase them.
      if (pendingHandle === handle) {
        return flushPendingLiveInputTextAndSelection(handle)
      }
      return waitForPendingLiveInputFlush()
    },
    [
      clearPendingLiveInputCommitAndSelection,
      flushPendingLiveInputTextAndSelection,
      waitForPendingLiveInputFlush
    ]
  )

  const handleLiveInputChange = useCallback(
    (text: string) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommitAndSelection()
        return
      }
      // Why: iOS kills an active dictation/IME session when JS writes a value
      // that differs from the native field text, so the controlled capture must
      // echo the field verbatim; only the PTY mirror sees normalized text.
      setLiveInputCapture(text)
      rawFieldTextRef.current = text
      // One-shot pair marker for the selection that follows this text change.
      expectsPairedSelectionAfterTextChangeRef.current = true
      applyLiveInputMirror(activeHandle, text, null)
    },
    [
      activeHandle,
      applyLiveInputMirror,
      clearPendingLiveInputCommitAndSelection,
      liveInputTerminalHandles,
      setLiveInputCapture
    ]
  )

  const handleLiveInputSelectionChange = useCallback(
    (event: TerminalLiveInputSelectionChangeEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const expectsPaired = expectsPairedSelectionAfterTextChangeRef.current
      expectsPairedSelectionAfterTextChangeRef.current = false
      const kind = classifyTerminalLiveSelectionEvent(expectsPaired)
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      const heldText = ownsPendingState ? heldLiveInputTextRef.current : ''
      // Soft reseat after text change only when nothing is held — never flush Hangul.
      if (
        !shouldApplyTerminalLiveCursorOnlySelectionMove({
          kind,
          heldText,
          allowSoftReseatWhenPaired: true
        })
      ) {
        return
      }
      applyLiveInputSelection(activeHandle, rawFieldTextRef.current, event.nativeEvent.selection)
    },
    [activeHandle, applyLiveInputSelection, liveInputTerminalHandles]
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommitAndSelection()
      }
      const key = event.nativeEvent.key
      const heldText = ownsPendingState ? heldLiveInputTextRef.current : ''
      const sentText = ownsPendingState ? sentLiveInputTextRef.current : ''
      const decision = getTerminalLiveSpecialKeyDecision({ key, heldText, sentText })
      // Why: physical arrows can emit keypress + selection; with field text the
      // selection handler owns the single PTY step — never send here too.
      if (isTerminalLiveFieldOwnedArrowKey(key) && (heldText.length > 0 || sentText.length > 0)) {
        return
      }
      switch (decision.kind) {
        case 'ignore':
        case 'local-edit':
          return
        case 'send-now':
        case 'commit-held-then-send': {
          const bytes = decision.bytes
          if (heldText.length > 0 || sentText.length > 0) {
            const sendPromise = queueLiveInputControl(activeHandle, bytes, {
              commitFieldBeforeControl: heldText.length > 0
            })
            clearPendingLiveInputCommitAndSelection()
            void sendPromise
            return
          }
          // Empty field: queue without ending a session.
          void queueLiveInputControl(activeHandle, bytes, { commitFieldBeforeControl: false })
          return
        }
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      clearPendingLiveInputCommitAndSelection,
      liveInputTerminalHandles,
      queueLiveInputControl
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    applyLiveInputMirror,
    clearPendingLiveInputCommit: clearPendingLiveInputCommitAndSelection,
    heldLiveInputTextRef,
    liveInputRef,
    liveInputTerminalHandles,
    pendingLiveInputHandleRef,
    queueLiveInputControl,
    sentLiveInputTextRef,
    setLiveInputCapture,
    waitForPendingLiveInputFlush
  })

  const handleLiveInputSubmit = useCallback(() => {
    if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
      return
    }
    const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
    const heldText = ownsPendingState ? heldLiveInputTextRef.current : ''
    const sentText = ownsPendingState ? sentLiveInputTextRef.current : ''
    const hasFieldSession = heldText.length > 0 || sentText.length > 0
    const sendPromise = queueLiveInputControl(activeHandle, '\r', {
      commitFieldBeforeControl: hasFieldSession
    })
    if (hasFieldSession) {
      clearPendingLiveInputCommitAndSelection()
    }
    void sendPromise
  }, [
    activeHandle,
    clearPendingLiveInputCommitAndSelection,
    liveInputTerminalHandles,
    queueLiveInputControl
  ])

  return {
    clearPendingLiveInputCommit: clearPendingLiveInputCommitAndSelection,
    flushPendingLiveInputBeforeExternalSend,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSelectionChange,
    handleLiveInputSubmit
  }
}
