import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { AccessibilityInfo, Animated, Text, View } from 'react-native'
import { transientToastStyles } from './transient-toast-styles'
import { spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

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
  // The live region stays mounted so a screen reader hears the message appear; the page has no announceForAccessibility.
  return (
    <View
      accessibilityLiveRegion="polite"
      pointerEvents="none"
      style={[transientToastStyles.toast, { bottom: bottomInset + spacing.lg }]}
    >
      {message ? <Text style={transientToastStyles.toastText}>{message}</Text> : null}
    </View>
  )
}

export function renderAnimatedToast(
  message: string | null,
  animatedStyle: ComponentProps<typeof Animated.View>['style']
) {
  return message ? (
    <Animated.View pointerEvents="none" style={[transientToastStyles.toast, animatedStyle]}>
      <Text style={transientToastStyles.toastText}>{message}</Text>
    </Animated.View>
  ) : null
}
