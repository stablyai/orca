import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { currentSoftKeyboardHeight } from '../../platform/keyboard/keyboard-occlusion'
import {
  clearTerminalLiveInputFocusTimer,
  focusTerminalLiveInputTarget,
  scheduleTerminalLiveInputFocus,
  type TerminalLiveInputFocusTarget,
  type TerminalLiveInputFocusTimerRef
} from './terminal-live-input'
import { dismissTerminalKeyboard } from '../keyboard/terminal-keyboard-dismiss'

type TerminalLiveInputFocusContext = {
  readonly canSend: boolean
  readonly reopenFocusedInputWhenKeyboardHidden: boolean
}

type UseTerminalLiveInputFocusOptions<T extends TerminalLiveInputFocusTarget> =
  TerminalLiveInputFocusContext & {
    readonly activeHandleRef: RefObject<string | null>
    readonly dismissKeyboard: () => void
    readonly inputRef: RefObject<T | null>
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
  dismissKeyboard,
  inputRef,
  lifecycleIdentity,
  lifecycleKey,
  reopenFocusedInputWhenKeyboardHidden,
  timerRef
}: UseTerminalLiveInputFocusOptions<T>): TerminalLiveInputFocusHandlers {
  const contextRef = useRef<TerminalLiveInputFocusContext>({
    canSend,
    reopenFocusedInputWhenKeyboardHidden
  })
  useLayoutEffect(() => {
    contextRef.current = { canSend, reopenFocusedInputWhenKeyboardHidden }
  }, [canSend, reopenFocusedInputWhenKeyboardHidden])

  const resetLiveInputFocus = useCallback(() => {
    clearTerminalLiveInputFocusTimer(timerRef)
    inputRef.current?.blur()
  }, [inputRef, timerRef])

  // Retained Expo routes must not carry focus work across navigation or reconnect scopes.
  useLayoutEffect(() => resetLiveInputFocus, [lifecycleIdentity, lifecycleKey, resetLiveInputFocus])

  const focusLiveInput = useCallback(() => {
    const context = contextRef.current
    if (!context.canSend) {
      return
    }
    focusTerminalLiveInputTarget(inputRef.current, {
      keyboardHeight: currentSoftKeyboardHeight(),
      reopenFocusedInputWhenKeyboardHidden: context.reopenFocusedInputWhenKeyboardHidden,
      refocus: () => scheduleTerminalLiveInputFocus(timerRef, focusLiveInput)
    })
  }, [inputRef, timerRef])

  // A tap or downward swipe on the terminal while the keyboard is up puts it away, in either input mode.
  const dismissKeyboardForGesture = useCallback(
    (handle: string): boolean => {
      if (handle !== activeHandleRef.current || currentSoftKeyboardHeight() <= 0) {
        return false
      }
      dismissTerminalKeyboard({
        clearPendingLiveInputFocus: () => clearTerminalLiveInputFocusTimer(timerRef),
        dismissKeyboard,
        liveInput: inputRef.current
      })
      return true
    },
    [activeHandleRef, dismissKeyboard, inputRef, timerRef]
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
      if (handle !== activeHandleRef.current || !context.canSend) {
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
