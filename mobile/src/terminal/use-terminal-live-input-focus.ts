import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  clearTerminalLiveInputFocusTimer,
  focusTerminalLiveInputTarget,
  scheduleTerminalLiveInputFocus,
  type TerminalLiveInputFocusTarget,
  type TerminalLiveInputFocusTimerRef
} from './terminal-live-input'
import { dismissTerminalKeyboard } from './terminal-keyboard-dismiss'

type TerminalLiveInputFocusContext = {
  readonly canSend: boolean
  readonly keyboardHeight: number
  readonly liveInputEnabled: boolean
  readonly reopenFocusedInputWhenKeyboardHidden: boolean
}

type UseTerminalLiveInputFocusOptions<T extends TerminalLiveInputFocusTarget> =
  TerminalLiveInputFocusContext & {
    readonly activeHandleRef: RefObject<string | null>
    readonly inputRef: RefObject<T | null>
    readonly commandInputRef: RefObject<TerminalLiveInputFocusTarget | null>
    readonly dismissKeyboard: () => void
    readonly lifecycleIdentity: object | null
    readonly lifecycleKey: string
    readonly timerRef: TerminalLiveInputFocusTimerRef
  }

type TerminalLiveInputFocusHandlers = {
  readonly focusLiveInput: () => void
  readonly handleTerminalTap: (handle: string) => void
  readonly handleTerminalSwipeDown: (handle: string) => void
  readonly resetLiveInputFocus: () => void
}

export function useTerminalLiveInputFocus<T extends TerminalLiveInputFocusTarget>({
  activeHandleRef,
  canSend,
  commandInputRef,
  dismissKeyboard,
  inputRef,
  keyboardHeight,
  lifecycleIdentity,
  lifecycleKey,
  reopenFocusedInputWhenKeyboardHidden,
  liveInputEnabled,
  timerRef
}: UseTerminalLiveInputFocusOptions<T>): TerminalLiveInputFocusHandlers {
  const contextRef = useRef<TerminalLiveInputFocusContext>({
    canSend,
    keyboardHeight,
    liveInputEnabled,
    reopenFocusedInputWhenKeyboardHidden
  })
  useLayoutEffect(() => {
    contextRef.current = {
      canSend,
      keyboardHeight,
      liveInputEnabled,
      reopenFocusedInputWhenKeyboardHidden
    }
  }, [canSend, keyboardHeight, liveInputEnabled, reopenFocusedInputWhenKeyboardHidden])

  const resetLiveInputFocus = useCallback(() => {
    clearTerminalLiveInputFocusTimer(timerRef)
    inputRef.current?.blur()
  }, [inputRef, timerRef])

  // Retained Expo routes must not carry focus work across navigation or reconnect scopes.
  useLayoutEffect(() => resetLiveInputFocus, [lifecycleIdentity, lifecycleKey, resetLiveInputFocus])

  useLayoutEffect(() => {
    const inactive = liveInputEnabled ? commandInputRef : inputRef
    if (inactive.current?.isFocused?.()) {
      clearTerminalLiveInputFocusTimer(timerRef)
      const active = liveInputEnabled ? inputRef : commandInputRef
      active.current?.focus()
    }
  }, [commandInputRef, inputRef, liveInputEnabled, timerRef])

  const focusLiveInput = useCallback(() => {
    const context = contextRef.current
    if (!context.canSend || !context.liveInputEnabled) {
      return
    }
    focusTerminalLiveInputTarget(inputRef.current, {
      keyboardHeight: context.keyboardHeight,
      reopenFocusedInputWhenKeyboardHidden: context.reopenFocusedInputWhenKeyboardHidden,
      refocus: () => scheduleTerminalLiveInputFocus(timerRef, focusLiveInput)
    })
  }, [inputRef, timerRef])

  // A tap or downward swipe on the terminal while the keyboard is up puts it away, in either input mode.
  const dismissKeyboardForGesture = useCallback(
    (handle: string): boolean => {
      if (handle !== activeHandleRef.current || contextRef.current.keyboardHeight <= 0) {
        return false
      }
      dismissTerminalKeyboard({
        clearPendingLiveInputFocus: () => clearTerminalLiveInputFocusTimer(timerRef),
        commandInput: commandInputRef?.current ?? null,
        dismissKeyboard,
        liveInput: inputRef.current
      })
      return true
    },
    [activeHandleRef, commandInputRef, dismissKeyboard, inputRef, timerRef]
  )

  const handleTerminalSwipeDown = useCallback(
    (handle: string) => {
      dismissKeyboardForGesture(handle)
    },
    [dismissKeyboardForGesture]
  )

  const handleTerminalTap = useCallback(
    (handle: string) => {
      if (dismissKeyboardForGesture(handle)) {
        return
      }
      const context = contextRef.current
      if (handle !== activeHandleRef.current || !context.canSend || !context.liveInputEnabled) {
        return
      }
      // WKWebView still owns first responder during its touchend notification.
      scheduleTerminalLiveInputFocus(timerRef, () => {
        if (activeHandleRef.current === handle) {
          focusLiveInput()
        }
      })
    },
    [activeHandleRef, dismissKeyboardForGesture, focusLiveInput, timerRef]
  )

  return { focusLiveInput, handleTerminalSwipeDown, handleTerminalTap, resetLiveInputFocus }
}
