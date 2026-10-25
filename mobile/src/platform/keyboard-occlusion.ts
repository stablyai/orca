import { useEffect, useState } from 'react'
import { Keyboard } from 'react-native'
import { hostOs } from './host-os'

export type SoftKeyboardState = { readonly height: number; readonly visible: boolean }

const CLOSED: SoftKeyboardState = { height: 0, visible: false }

// Use iOS will-events to animate with the keyboard, Android did-events where will-events do not exist. Share one subscription for height and visibility.
export function useSoftKeyboard(): SoftKeyboardState {
  const [keyboard, setKeyboard] = useState<SoftKeyboardState>(CLOSED)

  useEffect(
    () =>
      // Keep visibility independent of height: a reported zero-height keyboard must still suppress terminal refits.
      subscribeSoftKeyboard(
        (height) => setKeyboard({ height: Math.max(0, height), visible: true }),
        () => setKeyboard(CLOSED)
      ),
    []
  )

  return keyboard
}

export function subscribeSoftKeyboard(
  onShow: (height: number, duration: number) => void,
  onHide: (duration: number) => void
): () => void {
  const showEvent = hostOs() === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
  const hideEvent = hostOs() === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
  const show = Keyboard.addListener(showEvent, (event) =>
    onShow(event.endCoordinates.height, event.duration)
  )
  const hide = Keyboard.addListener(hideEvent, (event) => onHide(event.duration))
  return () => {
    show.remove()
    hide.remove()
  }
}

// Seed late subscribers from metrics; iOS can still report open between willHide and didHide.
export function currentSoftKeyboardHeight(): number {
  return Keyboard.metrics()?.height ?? 0
}

export function useKeyboardOcclusion(): number {
  return useSoftKeyboard().height
}
