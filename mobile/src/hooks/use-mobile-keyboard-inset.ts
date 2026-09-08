import { useEffect, useState } from 'react'
import { Keyboard, Platform, type KeyboardEvent } from 'react-native'

export type MobileKeyboardInset = {
  height: number
  duration: number
}

export function useMobileKeyboardInset(): MobileKeyboardInset {
  const [inset, setInset] = useState<MobileKeyboardInset>(() => ({
    height: Math.max(0, Keyboard.metrics?.()?.height ?? 0),
    duration: 0
  }))

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const show = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
      setInset({ height: Math.max(0, event.endCoordinates?.height ?? 0), duration: event.duration })
    })
    const hide = Keyboard.addListener(hideEvent, (event: KeyboardEvent) => {
      setInset({ height: 0, duration: event.duration })
    })
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  return inset
}
