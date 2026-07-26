import { useEffect, useState } from 'react'
import { Dimensions, Keyboard, Platform, type KeyboardEvent } from 'react-native'
import { resolveMobileKeyboardInset } from '../platform/mobile-keyboard-inset'

export function useMobileSessionKeyboardHeight(
  notifyKeyboardVisibility: (visible: boolean) => void
): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0)

  useEffect(() => {
    const onShow = (event: KeyboardEvent) => {
      notifyKeyboardVisibility(true)
      setKeyboardHeight(Math.max(0, event.endCoordinates?.height ?? 0))
    }
    const onHide = () => {
      notifyKeyboardVisibility(false)
      setKeyboardHeight(0)
    }
    const onChangeFrame = (event: KeyboardEvent) => {
      const coordinates = event.endCoordinates
      const height = Math.max(0, coordinates?.height ?? 0)
      const screenHeight = Dimensions.get('screen').height
      const visible = height > 0 && (coordinates?.screenY ?? screenHeight - height) < screenHeight
      notifyKeyboardVisibility(visible)
      setKeyboardHeight(visible ? height : 0)
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const changeFrameEvent =
      Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidChangeFrame'
    const showSubscription = Keyboard.addListener(showEvent, onShow)
    const hideSubscription = Keyboard.addListener(hideEvent, onHide)
    const changeFrameSubscription = Keyboard.addListener(changeFrameEvent, onChangeFrame)

    return () => {
      showSubscription.remove()
      hideSubscription.remove()
      changeFrameSubscription.remove()
    }
  }, [notifyKeyboardVisibility])

  return keyboardHeight
}

export function resolveMobileSessionKeyboardLift(input: {
  keyboardHeight: number
  bottomInset: number
  platform: typeof Platform.OS
}): number {
  return resolveMobileKeyboardInset({
    ...input,
    includesSafeArea: false
  })
}
