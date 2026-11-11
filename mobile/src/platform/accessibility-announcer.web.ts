import { useCallback } from 'react'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'

// RNW's announceForAccessibility does nothing, so the shell announces; older shells and Android leave it to the page's live region.
export function useAccessibilityAnnouncer(): (message: string) => Promise<boolean> {
  const verbs = useNativeVerbs()
  return useCallback(
    async (message: string) => {
      if (!verbs.canAnnounce) {
        return false
      }
      return verbs.announce(message).catch(() => false)
    },
    [verbs]
  )
}
