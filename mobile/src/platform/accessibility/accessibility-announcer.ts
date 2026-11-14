import { useCallback } from 'react'
import { AccessibilityInfo } from 'react-native'

// Speak a message to the screen reader; false when the caller should put it in a live region instead.
export function useAccessibilityAnnouncer(): (message: string) => Promise<boolean> {
  return useCallback(async (message: string) => {
    AccessibilityInfo.announceForAccessibility(message)
    return true
  }, [])
}
