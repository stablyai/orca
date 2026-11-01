import { useEffect, useState } from 'react'
import { Dimensions, Keyboard } from 'react-native'
import { subscribeReservedRegionChanges } from '../layout/reserved-regions'
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

/**
 * The keyboard as events, for a consumer that animates with each one (the event's `duration`) rather
 * than rendering from state. iOS is told `will`, Android `did`.
 */
type KeyboardSubscriber = {
  onShow: (height: number, duration: number) => void
  onHide: (duration: number) => void
}
const subscribers = new Set<KeyboardSubscriber>()
let observing = false

function observeSoftKeyboard(): void {
  if (observing) {
    return
  }
  observing = true
  const showEvent = hostOs() === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
  const hideEvent = hostOs() === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
  let hiding = false
  let visible = false
  const reportHeight = (height: number, duration: number) => {
    for (const subscriber of subscribers) {
      subscriber.onShow(height, duration)
    }
  }
  // App-lifetime observation preserves explicit hide even between subscriber mounts.
  Keyboard.addListener(showEvent, (event) => {
    hiding = false
    visible = true
    reportHeight(event.endCoordinates.height, event.duration)
  })
  Keyboard.addListener(hideEvent, (event) => {
    hiding = true
    visible = false
    for (const subscriber of subscribers) {
      subscriber.onHide(event.duration)
    }
  })
  if (hostOs() === 'ios') {
    Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      const { screenY, height } = event.endCoordinates
      // Hide frames keep a height; only show can reopen after an explicit hide.
      if (hiding || screenY >= Dimensions.get('window').height || screenY + height <= 0) {
        return
      }
      reportHeight(height, event.duration)
    })
    subscribeReservedRegionChanges(({ keyboardInset }) => {
      if (visible && keyboardInset !== undefined && keyboardInset > 0) {
        reportHeight(keyboardInset, 0)
      }
    })
  }
}

export function subscribeSoftKeyboard(
  onShow: (height: number, duration: number) => void,
  onHide: (duration: number) => void
): () => void {
  const subscriber = { onShow, onHide }
  subscribers.add(subscriber)
  observeSoftKeyboard()
  return () => {
    subscribers.delete(subscriber)
  }
}

// Seed late subscribers from metrics; iOS can still report open between willHide and didHide.
export function currentSoftKeyboardHeight(): number {
  return Keyboard.metrics()?.height ?? 0
}

export function useKeyboardOcclusion(): number {
  return useSoftKeyboard().height
}
