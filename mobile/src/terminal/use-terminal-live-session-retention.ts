import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'

// Native text changes queued before a reset can arrive after it.
const ENDED_SESSION_ECHO_MS = 500

type EndedLiveInputSession = {
  readonly handle: string
  readonly text: string
  readonly at: number
}

type UseTerminalLiveSessionRetentionOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly clearPendingLiveInputCommit: () => void
  readonly connected: boolean
  readonly heldLiveInputTextRef: RefObject<string>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTextRef: RefObject<string>
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly sentLiveInputTextRef: RefObject<string>
  readonly updateLiveInputCapture: (text: string) => void
}

export function useTerminalLiveSessionRetention<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  clearPendingLiveInputCommit,
  connected,
  heldLiveInputTextRef,
  liveInputRef,
  liveInputTextRef,
  pendingLiveInputHandleRef,
  sentLiveInputTextRef,
  updateLiveInputCapture
}: UseTerminalLiveSessionRetentionOptions<TTabType>) {
  const savedSentByHandleRef = useRef<Map<string, string>>(new Map())
  const endedSessionTextRef = useRef<EndedLiveInputSession | null>(null)

  // Drop the cleared field's late native echo of whatever session just ended.
  const recordEndedSession = useCallback(
    (handle: string) => {
      const fieldText = liveInputTextRef.current
      if (fieldText.length > 0) {
        endedSessionTextRef.current = { handle, text: fieldText, at: Date.now() }
      }
    },
    [liveInputTextRef]
  )

  const clearEndedSessionEcho = useCallback(() => {
    endedSessionTextRef.current = null
  }, [])

  // Ignore the cleared field’s native echo or it would retype old text at the new cursor.
  const dropEndedSessionEcho = useCallback(
    (text: string): boolean => {
      const endedSession = endedSessionTextRef.current
      if (
        !endedSession ||
        endedSession.handle !== activeHandleRef.current ||
        Date.now() - endedSession.at > ENDED_SESSION_ECHO_MS
      ) {
        endedSessionTextRef.current = null
        return false
      }
      if (text === endedSession.text) {
        writeTerminalLiveInputText(liveInputRef, '')
        return true
      }
      // Ignore the clear’s empty echo until actual new input arrives.
      if (text.length > 0) {
        endedSessionTextRef.current = null
      }
      return false
    },
    [activeHandleRef, liveInputRef]
  )

  const clearSavedLiveInputSession = useCallback((handle?: string) => {
    if (handle) {
      savedSentByHandleRef.current.delete(handle)
    } else {
      savedSentByHandleRef.current.clear()
    }
  }, [])

  const applySeededLiveInputText = useCallback(
    (handle: string, text: string) => {
      savedSentByHandleRef.current.delete(handle)
      endedSessionTextRef.current = null
      sentLiveInputTextRef.current = text
      pendingLiveInputHandleRef.current = handle
      updateLiveInputCapture(text)
      writeTerminalLiveInputText(liveInputRef, text, {
        start: text.length,
        end: text.length
      })
    },
    [liveInputRef, pendingLiveInputHandleRef, sentLiveInputTextRef, updateLiveInputCapture]
  )

  useEffect(() => {
    // Outages make delivered echo unknown; reset mirror state or the next send may corrupt PTY text.
    if (!connected) {
      savedSentByHandleRef.current.clear()
      clearPendingLiveInputCommit()
    }
  }, [connected, clearPendingLiveInputCommit])

  useEffect(() => {
    const pendingHandle = pendingLiveInputHandleRef.current
    const isActiveTerminalLive = Boolean(
      activeHandle && (activeSessionTabType == null || activeSessionTabType === 'terminal')
    )
    // Null tab type during list lag is unknown; only a known switch retires input, while flush guards still reject stale targets.
    if (pendingHandle && (!isActiveTerminalLive || pendingHandle !== activeHandle)) {
      if (sentLiveInputTextRef.current.length > 0) {
        savedSentByHandleRef.current.set(pendingHandle, sentLiveInputTextRef.current)
      }
      clearPendingLiveInputCommit()
    }
    if (isActiveTerminalLive && activeHandle) {
      const saved = savedSentByHandleRef.current.get(activeHandle)
      if (
        saved &&
        liveInputTextRef.current.length === 0 &&
        sentLiveInputTextRef.current.length === 0 &&
        heldLiveInputTextRef.current.length === 0
      ) {
        applySeededLiveInputText(activeHandle, saved)
      }
    }
  }, [
    activeHandle,
    activeSessionTabType,
    applySeededLiveInputText,
    clearPendingLiveInputCommit,
    heldLiveInputTextRef,
    liveInputTextRef,
    pendingLiveInputHandleRef,
    sentLiveInputTextRef
  ])

  const seedLiveInputFromTerminalPrompt = useCallback(
    (handle: string, promptText: string): boolean => {
      if (
        !connected ||
        !promptText ||
        handle !== activeHandleRef.current ||
        (activeSessionTabTypeRef.current != null &&
          activeSessionTabTypeRef.current !== 'terminal') ||
        liveInputTextRef.current.length > 0 ||
        sentLiveInputTextRef.current.length > 0 ||
        heldLiveInputTextRef.current.length > 0
      ) {
        return false
      }
      const normalized = normalizeTerminalTextInput(promptText)
      if (normalized.length === 0) {
        return false
      }
      applySeededLiveInputText(handle, normalized)
      return true
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      applySeededLiveInputText,
      connected,
      heldLiveInputTextRef,
      liveInputTextRef,
      sentLiveInputTextRef
    ]
  )

  return {
    clearEndedSessionEcho,
    clearSavedLiveInputSession,
    dropEndedSessionEcho,
    recordEndedSession,
    seedLiveInputFromTerminalPrompt
  }
}
