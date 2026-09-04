import { Platform } from 'react-native'
import type { ViewStyle } from 'react-native'
import { useEffect, useMemo, useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  KeyboardState,
  runOnJS,
  useAnimatedKeyboard,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedKeyboardInfo,
  type AnimatedStyle
} from 'react-native-reanimated'
import {
  resolveNativeChatBottomPad,
  resolveNativeChatKeyboardDismissMode,
  nativeChatKeyboardIsReported,
  nativeChatKeyboardStaysLeaving,
  type NativeChatKeyboardDismissMode,
  type NativeChatKeyboardPhase
} from './mobile-native-chat-keyboard-lift'

function keyboardPhase(state: KeyboardState, isLeaving: boolean): NativeChatKeyboardPhase {
  'worklet'
  if (state === KeyboardState.UNKNOWN || state === KeyboardState.CLOSED) {
    return 'unreported'
  }
  return isLeaving ? 'dismissing' : 'settling'
}

function useUntrackedKeyboard(): AnimatedKeyboardInfo {
  const height = useSharedValue(0)
  const state = useSharedValue<KeyboardState>(KeyboardState.UNKNOWN)
  // Stable identity prevents the UI-thread mapper restarting on every render.
  return useMemo(() => ({ height, state }), [height, state])
}

// Reanimated's Android observer would take over Orca's manual window-inset handling.
const useKeyboardFrame = Platform.OS === 'ios' ? useAnimatedKeyboard : useUntrackedKeyboard

/** Follows iOS dismissal frames that arrive before the route's committed inset. */
export function useMobileNativeChatKeyboardLift(committedInset: number): {
  dismissMode: NativeChatKeyboardDismissMode
  padStyle: AnimatedStyle<ViewStyle>
} {
  const bottomInset = useSafeAreaInsets().bottom
  const keyboard = useKeyboardFrame()
  // Direction changes must not release an in-flight interactive dismissal.
  const keyboardIsLeaving = useSharedValue(false)
  useAnimatedReaction(
    () => keyboard.state.value,
    (state) => {
      keyboardIsLeaving.value = nativeChatKeyboardStaysLeaving({
        wasLeaving: keyboardIsLeaving.value,
        isClosing: state === KeyboardState.CLOSING,
        hasSettled: state === KeyboardState.OPEN || state === KeyboardState.CLOSED
      })
    }
  )
  const [keyboardIsReported, setKeyboardIsReported] = useState(false)
  useAnimatedReaction(
    () => nativeChatKeyboardIsReported(keyboardPhase(keyboard.state.value, false)),
    (reported, previous) => {
      if (reported !== previous) {
        runOnJS(setKeyboardIsReported)(reported)
      }
    }
  )
  // Retain a ceiling after keyboardWillHide zeroes the route inset.
  const [lastSettledPad, setLastSettledPad] = useState(0)
  useEffect(() => {
    if (committedInset > 0) {
      setLastSettledPad(committedInset + bottomInset)
    }
  }, [committedInset, bottomInset])
  // Registration order keeps this mapper behind the output-less latch reaction.
  const padStyle = useAnimatedStyle(() => ({
    paddingBottom: resolveNativeChatBottomPad({
      phase: keyboardPhase(keyboard.state.value, keyboardIsLeaving.value),
      liveKeyboardHeight: keyboard.height.value,
      committedInset,
      lastSettledPad,
      bottomInset
    })
  }))
  return {
    dismissMode: resolveNativeChatKeyboardDismissMode(Platform.OS, keyboardIsReported),
    padStyle
  }
}
