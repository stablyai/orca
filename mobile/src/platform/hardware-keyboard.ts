import { useCallback, useMemo, useReducer } from 'react'

export type HardwareKeyboardState = {
  keyboardVisible: boolean
  lastImeHeight: number
  hasReceivedHardwareKeyEvent: boolean
}

export type HardwareKeyboardEvent =
  | { type: 'ime-shown'; height: number }
  | { type: 'ime-hidden' }
  | { type: 'key-press' }

const INITIAL_STATE: HardwareKeyboardState = {
  keyboardVisible: false,
  lastImeHeight: 0,
  hasReceivedHardwareKeyEvent: false
}

export function reduceHardwareKeyboardState(
  state: HardwareKeyboardState,
  event: HardwareKeyboardEvent
): HardwareKeyboardState {
  if (event.type === 'ime-shown') {
    return {
      keyboardVisible: true,
      lastImeHeight: Math.max(0, event.height),
      hasReceivedHardwareKeyEvent: false
    }
  }
  if (event.type === 'ime-hidden') {
    return { ...state, keyboardVisible: false }
  }
  if (state.keyboardVisible) {
    return state
  }
  return { ...state, lastImeHeight: 0, hasReceivedHardwareKeyEvent: true }
}

export function resolveHardwareKeyboardAttached(state: HardwareKeyboardState): boolean {
  return !state.keyboardVisible && state.lastImeHeight < 120 && state.hasReceivedHardwareKeyEvent
}

export function useHardwareKeyboardAttached() {
  const [state, dispatch] = useReducer(reduceHardwareKeyboardState, INITIAL_STATE)
  const notifyHardwareKeyEvent = useCallback(() => dispatch({ type: 'key-press' }), [])
  const notifyImeShown = useCallback(
    (height: number) => dispatch({ type: 'ime-shown', height }),
    []
  )
  const notifyImeHidden = useCallback(() => dispatch({ type: 'ime-hidden' }), [])

  return useMemo(
    () => ({
      hardwareKeyboard: resolveHardwareKeyboardAttached(state),
      notifyHardwareKeyEvent,
      notifyImeShown,
      notifyImeHidden
    }),
    [notifyHardwareKeyEvent, notifyImeHidden, notifyImeShown, state]
  )
}
