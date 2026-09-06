import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { withTiming } from 'react-native-reanimated'
import { resolveBottomDrawerKeyboardInset } from './bottom-drawer-keyboard-inset'
import type { MobileKeyboardInset } from '../hooks/use-mobile-keyboard-inset'

const DEFAULT_KEYBOARD_DURATION_MS = 250

type KeyboardOffset = { value: number }

/**
 * Rides the drawer with the keyboard. `ridesKeyboard` is false for sheets pinned under a
 * picker: they stay visible for size but must not take the lift.
 */
export function useBottomDrawerKeyboardLift(args: {
  ridesKeyboard: boolean
  bottomInset: number
  fillAvailable: boolean
  keyboard: MobileKeyboardInset
  keyboardOffset: KeyboardOffset
  setKeyboardInset: (inset: number) => void
}): void {
  const { ridesKeyboard, bottomInset, fillAvailable, keyboard } = args
  const duration = keyboard.duration || DEFAULT_KEYBOARD_DURATION_MS
  const targetsRef = useRef(args)
  // Why an effect rather than a render write: React can discard a render, so a mutation there
  // leaks from UI that never commits. Declared first, so the lift effects below read this
  // commit's offset and setter.
  useEffect(() => {
    targetsRef.current = args
  })
  useEffect(() => {
    if (!ridesKeyboard) {
      targetsRef.current.keyboardOffset.value = 0
      targetsRef.current.setKeyboardInset(0)
    }
  }, [ridesKeyboard])

  // Why: no cleanup reset here. Every height change re-runs this effect, so a teardown reset
  // would snap the offset to 0 before the dismiss could animate — the drawer would drop to the
  // bottom instead of riding the keyboard down, and a mid-session height change would flash.
  const seedingRef = useRef(true)
  useEffect(() => {
    if (!ridesKeyboard) {
      seedingRef.current = true
      return
    }
    const inset = resolveBottomDrawerKeyboardInset({
      keyboardHeight: keyboard.height,
      bottomInset,
      fillAvailable,
      platform: Platform.OS
    })
    targetsRef.current.setKeyboardInset(inset)
    // Why: a keyboard already up when the sheet opens (autoFocus) has no transition to join,
    // so seed it instantly; every later change animates with the system's own duration.
    const seeding = seedingRef.current
    seedingRef.current = false
    targetsRef.current.keyboardOffset.value = seeding ? inset : withTiming(inset, { duration })
  }, [ridesKeyboard, bottomInset, fillAvailable, duration, keyboard.height])
}
