import { useEffect, useSyncExternalStore } from 'react'
import {
  getMobileHardwareKeyboardPreferences,
  loadMobileHardwareKeyboardPreferences,
  subscribeMobileHardwareKeyboardPreferences
} from './mobile-hardware-keyboard-preferences'

export function useMobileHardwareKeyboardPreferences() {
  const preferences = useSyncExternalStore(
    subscribeMobileHardwareKeyboardPreferences,
    getMobileHardwareKeyboardPreferences,
    getMobileHardwareKeyboardPreferences
  )
  useEffect(() => {
    void loadMobileHardwareKeyboardPreferences()
  }, [])
  return preferences
}
