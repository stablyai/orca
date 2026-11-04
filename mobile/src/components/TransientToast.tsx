import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Text, View } from 'react-native'
import { mobileSessionReviewCommentStyles } from '../session/mobile-session-review-comment-styles'
import { spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** A message that shows for three seconds, for surfaces that cover the session's own toast. */
export function useTransientToast() {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const showToast = useCallback((text: string) => {
    clearTimeout(timer.current)
    setMessage(text)
    // The toast has no focus or live region, so announce it on both platforms.
    AccessibilityInfo.announceForAccessibility(text)
    timer.current = setTimeout(() => setMessage(null), 3_000)
  }, [])
  return { message, showToast }
}

export function TransientToast({
  message,
  bottomInset
}: {
  message: string | null
  bottomInset: number
}) {
  useMobileColorScheme()
  return message ? (
    <View
      accessibilityLiveRegion="polite"
      pointerEvents="none"
      style={[mobileSessionReviewCommentStyles.toast, { bottom: bottomInset + spacing.lg }]}
    >
      <Text style={mobileSessionReviewCommentStyles.toastText}>{message}</Text>
    </View>
  ) : null
}
