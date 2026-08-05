import { useEffect } from 'react'
import { AccessibilityInfo } from 'react-native'

export function useMobileNativeChatLoadEarlierAccessibility(
  loadingEarlier: boolean | undefined,
  loadEarlierError: string | null | undefined
): { isLoadingEarlier: boolean; accessibilityLabel: string } {
  const isLoadingEarlier = loadingEarlier === true
  const accessibilityLabel = isLoadingEarlier
    ? 'Loading earlier messages'
    : loadEarlierError
      ? `${loadEarlierError}. Tap to retry`
      : 'Load earlier messages'

  useEffect(() => {
    if (loadEarlierError && !isLoadingEarlier) {
      AccessibilityInfo.announceForAccessibility(accessibilityLabel)
    }
  }, [isLoadingEarlier, accessibilityLabel, loadEarlierError])

  return { isLoadingEarlier, accessibilityLabel }
}
