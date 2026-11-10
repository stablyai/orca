import { useLayoutEffect, useRef, useState } from 'react'
import { Alert, Platform, Pressable, Text } from 'react-native'
import { Check, Copy } from 'lucide-react-native'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useClipboardWriter } from '../platform/clipboard'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

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
  useMobileColorScheme()
  const t = useMobileTranslation()
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
    } catch (error) {
      if (latestAttempt.current !== attempt) {
        return
      }
      if (Platform.OS === 'web') {
        showFeedback({ status: 'failed' }, attempt)
      } else {
        Alert.alert(
          translate('components.sourceCopyButton.copyFailed', 'Copy failed'),
          error instanceof Error
            ? error.message
            : translate(
                'components.sourceCopyButton.clipboardRejected',
                'The clipboard rejected the text.'
              )
        )
      }
      return
    }
    if (latestAttempt.current !== attempt || sourceVersion.current !== attempt.sourceVersion) {
      return
    }
    showFeedback({ status: 'copied', text }, attempt)
  }
  const copied = feedback?.status === 'copied' && feedback.text === text
  const failed = feedback?.status === 'failed'
  const label = failed
    ? t('components.sourceCopyButton.failed', 'Failed')
    : copied
      ? partial
        ? t('components.sourceCopyButton.copiedLoaded', 'Copied loaded')
        : t('common.copied', 'Copied')
      : partial
        ? t('components.sourceCopyButton.copyLoaded', 'Copy loaded')
        : t('common.copy', 'Copy')
  const failureLabel = t('components.sourceCopyButton.couldNotCopy', "Couldn't copy")
  const Icon = copied ? Check : Copy
  const iconColor = failed ? colors.statusRed : copied ? colors.statusGreen : colors.textMuted
  return (
    <Pressable
      style={({ pressed }) => [styles.button, partial && styles.partial, pressed && styles.pressed]}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={failed ? failureLabel : accessibilityLabel}
      accessibilityLiveRegion={failed ? 'polite' : undefined}
      accessibilityValue={{ text: failed ? failureLabel : copied ? label : undefined }}
      aria-valuetext={failed ? failureLabel : copied ? label : undefined}
      accessibilityState={{ disabled: text.length === 0 }}
      disabled={text.length === 0}
      onPress={() => void copy()}
    >
      <Icon size={14} color={iconColor} />
      {partial ? <Text style={styles.label}>{label}</Text> : null}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: 24,
    height: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.control
  },
  partial: { width: 128, height: 32, paddingHorizontal: spacing.sm },
  pressed: { backgroundColor: colors.bgRaised },
  label: { color: colors.textMuted, fontSize: typography.metaSize }
}))
