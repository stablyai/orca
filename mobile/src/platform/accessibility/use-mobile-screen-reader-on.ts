import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/** Whether VoiceOver or TalkBack is running, following changes. */
export function useMobileScreenReaderOn(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => live && setOn(enabled))
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setOn)
    return () => {
      live = false
      subscription.remove()
    }
  }, [])
  return on
}
