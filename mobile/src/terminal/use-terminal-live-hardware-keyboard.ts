import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  clearTerminalLiveInputFocusTimer,
  scheduleTerminalLiveInputFocus,
  type TerminalLiveInputFocusTimerRef
} from './terminal-live-input'
import {
  getTerminalLiveHardwareKeyboardFocusDecision,
  planExplicitSoftKeyboardFocus,
  shouldAutoSilentFocusLiveInput
} from './terminal-live-hardware-keyboard-focus'
import type { TerminalLiveHardwareKeyEvent } from './terminal-live-hardware-key-mapping'

type UseTerminalLiveHardwareKeyboardOptions = {
  readonly focusScopeKey: string | null
  readonly liveInputEnabled: boolean
  readonly canSend: boolean
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputFocusTimerRef: TerminalLiveInputFocusTimerRef
  readonly modalOpen: boolean
  readonly handleLiveInputHardwareKey: (event: TerminalLiveHardwareKeyEvent) => void
}

export function useTerminalLiveHardwareKeyboard({
  focusScopeKey,
  liveInputEnabled,
  canSend,
  liveInputRef,
  liveInputFocusTimerRef,
  modalOpen,
  handleLiveInputHardwareKey
}: UseTerminalLiveHardwareKeyboardOptions): {
  readonly showSoftInputOnFocus: boolean
  readonly hardwareCaptureEnabled: boolean
  readonly requestSoftKeyboardFocus: () => void
  readonly clearSoftKeyboardRequest: () => void
  readonly onHardwareKey: (event: { nativeEvent: TerminalLiveHardwareKeyEvent }) => void
} {
  const [wantSoftKeyboard, setWantSoftKeyboard] = useState(false)
  // Why: explicit soft focus must run after React applies showSoftInputOnFocus=true.
  const [pendingSoftFocusSeq, setPendingSoftFocusSeq] = useState(0)
  const pendingSoftFocusNeedsBlurRef = useRef(false)
  const modalOpenRef = useRef(modalOpen)
  modalOpenRef.current = modalOpen

  const decision = getTerminalLiveHardwareKeyboardFocusDecision({
    wantSoftKeyboard,
    liveInputEnabled,
    canSend
  })
  const showSoftInputOnFocus = decision.kind === 'soft-focus'

  const clearSoftKeyboardRequest = useCallback(() => {
    setWantSoftKeyboard(false)
  }, [])

  const requestSoftKeyboardFocus = useCallback(() => {
    // Why: the live-mode toggle requests focus before its enabled state re-renders.
    if (!canSend) {
      return
    }
    const isFocused = liveInputRef.current?.isFocused?.() ?? false
    const plan = planExplicitSoftKeyboardFocus({
      alreadyWantsSoftKeyboard: wantSoftKeyboard,
      isFocused
    })
    setWantSoftKeyboard(true)
    if (plan.kind === 'focus-now') {
      scheduleTerminalLiveInputFocus(liveInputFocusTimerRef, () => liveInputRef.current?.focus())
      return
    }
    pendingSoftFocusNeedsBlurRef.current = plan.kind === 'blur-refocus-after-latch'
    setPendingSoftFocusSeq((seq) => seq + 1)
  }, [canSend, liveInputFocusTimerRef, liveInputRef, wantSoftKeyboard])

  // After wantSoftKeyboard commits, focus with showSoftInputOnFocus already true.
  useEffect(() => {
    if (pendingSoftFocusSeq === 0 || !showSoftInputOnFocus) {
      return
    }
    const needsBlur = pendingSoftFocusNeedsBlurRef.current
    pendingSoftFocusNeedsBlurRef.current = false
    scheduleTerminalLiveInputFocus(liveInputFocusTimerRef, () => {
      const input = liveInputRef.current
      if (!input) {
        return
      }
      if (needsBlur && input.isFocused?.()) {
        input.blur()
        scheduleTerminalLiveInputFocus(liveInputFocusTimerRef, () => input.focus())
        return
      }
      input.focus()
    })
  }, [liveInputFocusTimerRef, liveInputRef, pendingSoftFocusSeq, showSoftInputOnFocus])

  // Focus scope changes include terminal switches; modal close is intentionally
  // absent from these dependencies so it cannot steal focus back.
  useEffect(() => {
    if (modalOpenRef.current) {
      return
    }
    if (
      !shouldAutoSilentFocusLiveInput({
        liveInputEnabled,
        canSend,
        wantSoftKeyboard,
        isFocused: liveInputRef.current?.isFocused?.() ?? false,
        modalOpen: false
      })
    ) {
      return
    }
    scheduleTerminalLiveInputFocus(liveInputFocusTimerRef, () => liveInputRef.current?.focus())
  }, [
    canSend,
    focusScopeKey,
    liveInputEnabled,
    liveInputFocusTimerRef,
    liveInputRef,
    wantSoftKeyboard
  ])

  // Modal/action-sheet open: cancel pending focus and clear soft latch; do not
  // re-trigger silent focus when the modal later closes.
  useEffect(() => {
    if (!modalOpen) {
      return
    }
    clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
    setWantSoftKeyboard(false)
  }, [liveInputFocusTimerRef, modalOpen])

  const onHardwareKey = useCallback(
    (event: { nativeEvent: TerminalLiveHardwareKeyEvent }) => {
      // Why: native prop updates and queued view events can cross briefly when
      // a modal opens or sending disables, so JS enforces the same ownership.
      if (!liveInputEnabled || !canSend || modalOpen) {
        return
      }
      handleLiveInputHardwareKey(event.nativeEvent)
    },
    [canSend, handleLiveInputHardwareKey, liveInputEnabled, modalOpen]
  )

  return {
    showSoftInputOnFocus,
    hardwareCaptureEnabled: liveInputEnabled && canSend && !modalOpen,
    requestSoftKeyboardFocus,
    clearSoftKeyboardRequest,
    onHardwareKey
  }
}
