import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  clearTerminalLiveInputFocusTimer,
  focusTerminalLiveInputTarget,
  scheduleTerminalLiveInputFocus,
  type TerminalLiveInputFocusTarget,
  type TerminalLiveInputFocusTimerRef
} from './terminal-live-input'

type TerminalLiveInputFocusContext = {
  readonly canSend: boolean
  readonly keyboardHeight: number
  readonly liveInputEnabled: boolean
}

type UseTerminalLiveInputFocusOptions<T extends TerminalLiveInputFocusTarget> =
  TerminalLiveInputFocusContext & {
    readonly activeHandleRef: RefObject<string | null>
    readonly inputRef: RefObject<T | null>
    readonly lifecycleIdentity: object | null
    readonly lifecycleKey: string
    readonly timerRef: TerminalLiveInputFocusTimerRef
  }

type TerminalLiveInputFocusHandlers = {
  readonly focusLiveInput: () => void
  readonly handleTerminalTap: (handle: string) => void
  readonly resetLiveInputFocus: () => void
}

export function useTerminalLiveInputFocus<T extends TerminalLiveInputFocusTarget>({
  activeHandleRef,
  canSend,
  inputRef,
  keyboardHeight,
  lifecycleIdentity,
  lifecycleKey,
  liveInputEnabled,
  timerRef
}: UseTerminalLiveInputFocusOptions<T>): TerminalLiveInputFocusHandlers {
  const contextRef = useRef<TerminalLiveInputFocusContext>({
    canSend,
    keyboardHeight,
    liveInputEnabled
  })
  useLayoutEffect(() => {
    contextRef.current = { canSend, keyboardHeight, liveInputEnabled }
  }, [canSend, keyboardHeight, liveInputEnabled])

  const resetLiveInputFocus = useCallback(() => {
    clearTerminalLiveInputFocusTimer(timerRef)
    inputRef.current?.blur()
  }, [inputRef, timerRef])

  // Retained Expo routes must not carry focus work across navigation or reconnect scopes.
  useLayoutEffect(() => resetLiveInputFocus, [lifecycleIdentity, lifecycleKey, resetLiveInputFocus])

  const focusLiveInput = useCallback(() => {
    const context = contextRef.current
    if (!context.canSend || !context.liveInputEnabled) {
      return
    }
    focusTerminalLiveInputTarget(inputRef.current, {
      keyboardHeight: context.keyboardHeight,
      refocus: () => scheduleTerminalLiveInputFocus(timerRef, focusLiveInput)
    })
  }, [inputRef, timerRef])

  const handleTerminalTap = useCallback(
    (handle: string) => {
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
    [activeHandleRef, focusLiveInput, timerRef]
  )

  return { focusLiveInput, handleTerminalTap, resetLiveInputFocus }
}
