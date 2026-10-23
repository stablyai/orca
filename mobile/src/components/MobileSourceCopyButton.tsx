import { useLayoutEffect, useRef, useState } from 'react'
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, Copy } from 'lucide-react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { colors, MIN_TOUCH_TARGET, motion, radii, spacing, textStyles } from '../theme/mobile-theme'
import { pressTransition } from './ui/transition-styles'

type CopyFeedback = { status: 'copied'; text: string } | { status: 'failed' }

export function MobileSourceCopyButton({
  text,
  accessibilityLabel,
  partial = false
}: {
  text: string
  accessibilityLabel: string
  partial?: boolean
}): React.JSX.Element {
  const clipboard = useClipboardWriter()
  const [feedback, setFeedback] = useState<CopyFeedback | null>(null)
  const latestAttempt = useRef<{ sourceVersion: number } | null>(null)
  const sourceVersion = useRef(0)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  if (feedback?.status === 'copied' && feedback.text !== text) {
    setFeedback(null)
  }
  useLayoutEffect(
    () => () => {
      latestAttempt.current = null
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current)
        resetTimer.current = null
      }
    },
    []
  )
  // Streaming invalidates success feedback, while the pending user action still owns failures.
  useLayoutEffect(() => {
    sourceVersion.current++
    if (feedback?.status !== 'failed' && resetTimer.current !== null) {
      clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
  }, [text])

  const showFeedback = (result: CopyFeedback, attempt: { sourceVersion: number }) => {
    setFeedback(result)
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null
      if (latestAttempt.current === attempt) {
        setFeedback(null)
      }
    }, 1500)
  }

  const copy = async () => {
    if (text.length === 0) {
      return
    }
    const attempt = { sourceVersion: sourceVersion.current }
    latestAttempt.current = attempt
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
    setFeedback(null)
    try {
      await clipboard.writeText(text)
    } catch {
      if (latestAttempt.current !== attempt) {
        return
      }
      triggerError()
      if (Platform.OS === 'web') {
        showFeedback({ status: 'failed' }, attempt)
      } else {
        Alert.alert("Couldn't copy", 'The clipboard rejected the text. Try again.')
      }
      return
    }
    if (latestAttempt.current !== attempt || sourceVersion.current !== attempt.sourceVersion) {
      return
    }
    triggerSuccess()
    showFeedback({ status: 'copied', text }, attempt)
  }
  const copied = feedback?.status === 'copied' && feedback.text === text
  const failed = feedback?.status === 'failed'
  const label = failed
    ? 'Failed'
    : copied
      ? partial
        ? 'Copied loaded'
        : 'Copied'
      : partial
        ? 'Copy loaded'
        : 'Copy'
  const Icon = copied ? Check : Copy
  const iconColor = failed ? colors.danger : copied ? colors.statusGreen : colors.textMuted
  return (
    <Pressable
      style={[styles.touch, partial && styles.touchPartial]}
      accessibilityRole="button"
      accessibilityLabel={failed ? "Couldn't copy" : accessibilityLabel}
      accessibilityLiveRegion={failed ? 'polite' : undefined}
      accessibilityValue={{ text: failed ? "Couldn't copy" : copied ? label : undefined }}
      aria-valuetext={failed ? "Couldn't copy" : copied ? label : undefined}
      accessibilityState={{ disabled: text.length === 0 }}
      disabled={text.length === 0}
      onPress={() => void copy()}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.button,
            partial && styles.partial,
            pressed && styles.pressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <Icon size={16} color={iconColor} strokeWidth={2.2} />
          {partial ? <Text style={styles.label}>{label}</Text> : null}
        </View>
      )}
    </Pressable>
  )
}

// A 44 pt touch box around a 32 pt circle (a capsule when it names what it copies).
const styles = StyleSheet.create({
  touch: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  touchPartial: { width: 'auto', alignItems: 'flex-start' },
  button: {
    width: 32,
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs + 2,
    borderRadius: radii.pill
  },
  partial: { width: 'auto', minWidth: 128, paddingHorizontal: spacing.md },
  pressed: { backgroundColor: colors.fill, transform: [{ scale: motion.pressedIconScale }] },
  label: { ...textStyles.footnote, fontWeight: '500', color: colors.textSecondary }
})
