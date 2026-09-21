import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

/**
 * How much of the bottom of the layout viewport the software keyboard covers.
 *
 * Native: the keyboard's own reported height, from the events the platform sends. iOS is told
 * `will`, Android `did`, which is the difference between animating with the keyboard and after it.
 *
 * The web sibling is where this earns its place under `platform/`: react-native-web's `Keyboard` is
 * a stub — `addListener` returns a subscription that never fires and `isVisible()` is always false
 * — so a screen inside the shell's page that waits for a keyboard event waits forever, and the
 * software keyboard covers whatever sits at the bottom of the document. The browser reports the
 * same geometry a different way, through `visualViewport`.
 */
export function useKeyboardOcclusion(): number {
  const [keyboardLift, setKeyboardLift] = useState(0)

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const onShow = Keyboard.addListener(showEvent, (event) => {
      // The keyboard's own height already describes the obscured area; the consumer adds whatever
      // clearance it wants above it.
      setKeyboardLift(Math.max(0, event.endCoordinates.height))
    })
    const onHide = Keyboard.addListener(hideEvent, () => setKeyboardLift(0))

    return () => {
      onShow.remove()
      onHide.remove()
    }
  }, [])

  return keyboardLift
}

/**
 * The bottom padding a composer needs to clear the keyboard, which natively is none.
 *
 * `KeyboardAvoidingView` already moves the composer on a phone, so adding padding there would move
 * it twice. It is inert on the web for the same reason the `Keyboard` stub is — it is driven by
 * those events — so there the padding is the whole of the avoidance.
 *
 * A second name rather than a `Platform.OS` branch at the call site: this one subscribes to nothing
 * on a phone, so a composer that asks for it renders exactly as many times as it does today.
 */
export function useKeyboardAvoidingPadding(): number {
  return 0
}
