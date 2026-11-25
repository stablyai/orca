import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { AccessibilityInfo, Animated, Pressable, Text, View } from 'react-native'
import { transientToastStyles } from './transient-toast-styles'
import { spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

/** One thing to do about the message, such as Restart, beside it in the toast. */
export type TransientToastAction = { label: string; onPress: () => void }

/** A message that shows for three seconds (five with an action), for surfaces that cover the session's own toast. */
export function useTransientToast() {
  const [message, setMessage] = useState<string | null>(null)
  const [action, setAction] = useState<TransientToastAction | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = useCallback((text: string, next?: TransientToastAction) => {
    clearTimeout(timer.current)
    setMessage(text)
    setAction(next ?? null)
    // The toast has no focus or live region, so announce it on both platforms.
    AccessibilityInfo.announceForAccessibility(next ? `${text}. ${next.label}` : text)
    timer.current = setTimeout(
      () => {
        setMessage(null)
        setAction(null)
      },
      next ? 5_000 : 3_000
    )
  }, [])
  const showToast = useCallback((text: string) => show(text), [show])
  return { message, action, showToast, showActionToast: show }
}

export function TransientToast({
  message,
  bottomInset,
  action
}: {
  message: string | null
  bottomInset: number
  action?: TransientToastAction | null
}) {
  useMobileColorScheme()
  // The live region stays mounted so a screen reader hears the message appear; the page has no announceForAccessibility.
  return (
    <View
      accessibilityLiveRegion="polite"
      pointerEvents={message && action ? 'box-none' : 'none'}
      style={[transientToastStyles.toast, { bottom: bottomInset + spacing.lg }]}
    >
      {message && action ? (
        <View style={[transientToastStyles.toastText, transientToastStyles.withAction]}>
          <Text style={transientToastStyles.message}>{message}</Text>
          <Pressable
            onPress={action.onPress}
            hitSlop={12}
            accessibilityRole="button"
            style={({ pressed }) => pressed && transientToastStyles.actionPressed}
          >
            <Text style={transientToastStyles.action}>{action.label}</Text>
          </Pressable>
        </View>
      ) : message ? (
        <Text style={transientToastStyles.toastText}>{message}</Text>
      ) : null}
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
