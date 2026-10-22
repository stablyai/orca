import { useCallback, useEffect, useRef } from 'react'
import { reportedLiveInputComposing } from '../platform/live-input-composing-range'
import {
  getTerminalLiveSpecialKeyDecision,
  type TerminalLiveInputSelection
} from './terminal-live-text-commit'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import { useTerminalLiveAccessoryInputCommit } from './use-terminal-live-accessory-input-commit'
import type {
  TerminalLiveInputChangeEvent,
  TerminalLiveInputCommitHandlers,
  TerminalLiveInputCommitOptions,
  TerminalLiveInputKeyPressEvent,
  TerminalLiveInputSelectionChangeEvent
} from './terminal-live-input-commit-contract'

// Native text changes queued before a reset can arrive after it.
const ENDED_SESSION_ECHO_MS = 500

/** Mirrors committed field text to the terminal while keeping native caret movement local. */
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
  const interactionGenerationRef = useRef(0)
  const liveInputTextRef = useRef('')
  const endedSessionTextRef = useRef<{
    readonly handle: string
    readonly text: string
    readonly at: number
  } | null>(null)
  const liveInputSelectionRef = useRef<TerminalLiveInputSelection | null>(null)
  const liveInputSelectionSnapshotRef = useRef<{
    readonly text: string
    readonly selection: TerminalLiveInputSelection
  } | null>(null)
  const updateLiveInputCapture = useCallback(
    (text: string) => {
      liveInputTextRef.current = text
      if (text.length === 0) {
        liveInputSelectionRef.current = null
        liveInputSelectionSnapshotRef.current = null
      }
      setLiveInputCapture(text)
    },
    [setLiveInputCapture]
  )
  const advanceLiveInputInteractionGeneration = useCallback(() => {
    interactionGenerationRef.current += 1
  }, [])
  const {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    endLiveInputSessionThenSend,
    flushPendingLiveInputText,
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
    setLiveInputCapture: updateLiveInputCapture
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

  const flushPendingLiveInputBeforeExternalSend = useCallback(
    async (handle: string): Promise<boolean> => {
      advanceLiveInputInteractionGeneration()
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
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      waitForPendingLiveInputFlush
    ]
  )

  // The mirror assumes the cursor follows its text, so a click starts a new editing session.
  const sendLiveInputClick = useCallback(
    (handle: string, bytes: string): Promise<boolean> => {
      advanceLiveInputInteractionGeneration()
      const fieldText = liveInputTextRef.current
      endedSessionTextRef.current =
        fieldText.length > 0 ? { handle, text: fieldText, at: Date.now() } : null
      return endLiveInputSessionThenSend(handle, bytes)
    },
    [advanceLiveInputInteractionGeneration, endLiveInputSessionThenSend]
  )

  const getEndedSession = useCallback(() => {
    const endedSession = endedSessionTextRef.current
    if (
      !endedSession ||
      endedSession.handle !== activeHandleRef.current ||
      Date.now() - endedSession.at > ENDED_SESSION_ECHO_MS
    ) {
      endedSessionTextRef.current = null
      return null
    }
    return endedSession
  }, [activeHandleRef])

  // Replaying the cleared field's native echo would retype it at the clicked cursor.
  const dropEndedSessionEcho = useCallback(
    (text: string): boolean => {
      const endedSession = getEndedSession()
      if (!endedSession) {
        return false
      }
      if (text === endedSession.text) {
        liveInputSelectionRef.current = null
        liveInputSelectionSnapshotRef.current = null
        writeTerminalLiveInputText(liveInputRef, '')
        return true
      }
      // The clear's own empty echo keeps the guard; the first new input ends it.
      if (text.length > 0) {
        endedSessionTextRef.current = null
      }
      return false
    },
    [getEndedSession, liveInputRef]
  )

  const handleLiveInputChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputChangeEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      // Why: iOS kills an active dictation/IME session when JS writes a value
      // that differs from the native field text, so the controlled capture must
      // echo the field verbatim; only the PTY mirror sees normalized text.
      advanceLiveInputInteractionGeneration()
      // DOM input identifies a fresh edit even when a mobile keyboard omits key events.
      if (nativeEvent.inputType) {
        endedSessionTextRef.current = null
      } else if (dropEndedSessionEcho(nativeEvent.text)) {
        return
      }
      const snapshot = liveInputSelectionSnapshotRef.current
      liveInputSelectionRef.current =
        snapshot?.text === nativeEvent.text ? snapshot.selection : null
      updateLiveInputCapture(nativeEvent.text)
      void applyLiveInputMirror(
        activeHandle,
        normalizeTerminalTextInput(nativeEvent.text),
        reportedLiveInputComposing(nativeEvent.isComposing)
      )
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      dropEndedSessionEcho,
      liveInputTerminalHandles,
      updateLiveInputCapture
    ]
  )

  const getLiveInputInteractionGeneration = useCallback(() => interactionGenerationRef.current, [])

  const handleLiveInputSelectionChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputSelectionChangeEvent) => {
      const endedSession = getEndedSession()
      if (endedSession && nativeEvent.text === endedSession.text) {
        return
      }
      // Why: only accessory deletion reads this; native caret movement never sends PTY controls.
      const snapshot = {
        text: nativeEvent.text ?? liveInputTextRef.current,
        selection: nativeEvent.selection
      }
      liveInputSelectionSnapshotRef.current = snapshot
      liveInputSelectionRef.current =
        snapshot.text === liveInputTextRef.current ? snapshot.selection : null
    },
    [getEndedSession]
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      advanceLiveInputInteractionGeneration()
      if (endedSessionTextRef.current) {
        liveInputSelectionRef.current = null
        liveInputSelectionSnapshotRef.current = null
        endedSessionTextRef.current = null
      }
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
          void sendTerminalLiveControlAfterPendingFlush(waitForPendingLiveInputFlush, () =>
            sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return
        case 'commit-held-then-send':
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
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      liveInputTerminalHandles,
      sendLiveTerminalInputRef,
      waitForPendingLiveInputFlush
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    liveInputComposingRef,
    liveInputRef,
    liveInputTextRef,
    liveInputSelectionRef,
    liveInputTerminalHandles,
    onInteraction: advanceLiveInputInteractionGeneration,
    pendingLiveInputHandleRef,
    sentLiveInputTextRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture: updateLiveInputCapture,
    waitForPendingLiveInputFlush
  })

  const handleLiveInputSubmit = useCallback((): Promise<boolean> => {
    if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
      return Promise.resolve(false)
    }
    advanceLiveInputInteractionGeneration()
    return sendTerminalLiveControlAfterPendingFlush(
      () => flushPendingLiveInputText(activeHandle),
      () => sendLiveTerminalInputRef.current(activeHandle, '\r')
    )
  }, [
    activeHandle,
    advanceLiveInputInteractionGeneration,
    flushPendingLiveInputText,
    liveInputTerminalHandles,
    sendLiveTerminalInputRef
  ])

  return {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    getLiveInputInteractionGeneration,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSelectionChange,
    handleLiveInputSubmit,
    sendLiveInputClick
  }
}
