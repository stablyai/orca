import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

/** How much of the bottom of the layout viewport it covers, and whether it is open at all. */
export type SoftKeyboardState = { readonly height: number; readonly visible: boolean }

const CLOSED: SoftKeyboardState = { height: 0, visible: false }

/**
 * What the software keyboard is doing, from the events the platform sends. iOS is told `will`,
 * Android `did`, which is the difference between animating with the keyboard and after it. Both
 * facts from one subscription, because the session screen wants each and two hooks would cost it
 * two listener pairs and two renders per keyboard event.
 *
 * The web sibling is where this earns its place under `platform/`: react-native-web's `Keyboard` is
 * a stub — `addListener` returns a subscription that never fires and `isVisible()` is always false
 * — so a screen inside the shell's page that waits for a keyboard event waits forever, and the
 * software keyboard covers whatever sits at the bottom of the document. There the two facts come
 * apart, and neither is an event.
 */
export function useSoftKeyboard(): SoftKeyboardState {
  const [keyboard, setKeyboard] = useState<SoftKeyboardState>(CLOSED)

  useEffect(
    () =>
      // The keyboard's own height already describes the obscured area; the consumer adds whatever
      // clearance it wants above it. Open is the event, not the height: a keyboard that reports 0
      // is still one nobody wants the terminal re-fitted under.
      subscribeSoftKeyboard(
        (height) => setKeyboard({ height: Math.max(0, height), visible: true }),
        () => setKeyboard(CLOSED)
      ),
    []
  )

  return keyboard
}

/**
 * The keyboard as events, for a consumer that animates with each one (the event's `duration`) rather
 * than rendering from state. iOS is told `will`, Android `did`.
 */
export function subscribeSoftKeyboard(
  onShow: (height: number, duration: number) => void,
  onHide: (duration: number) => void
): () => void {
  const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
  const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
  const show = Keyboard.addListener(showEvent, (event) =>
    onShow(event.endCoordinates.height, event.duration)
  )
  const hide = Keyboard.addListener(hideEvent, (event) => onHide(event.duration))
  return () => {
    show.remove()
    hide.remove()
  }
}

/**
 * The keyboard already up, which sends no show event to a late subscriber. React Native sets this on
 * `did` events, so on iOS it can still read open between `willHide` and `didHide`.
 */
export function currentSoftKeyboardHeight(): number {
  return Keyboard.metrics()?.height ?? 0
}

/** The occluded strip alone, for the callers that lift by it and never ask whether it is open. */
export function useKeyboardOcclusion(): number {
  return useSoftKeyboard().height
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
