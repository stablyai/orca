import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

export function useMobileSourceControlKeyboardLift(): number {
  const [keyboardLift, setKeyboardLift] = useState(0)

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const onShow = Keyboard.addListener(showEvent, (event) => {
      // Why: iOS keyboard height already describes the obscured screen area.
      // Subtracting the safe-area inset lets the commit bar tuck under the keyboard.
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
