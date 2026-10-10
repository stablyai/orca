import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent
} from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  CAPTION_LINE_HEIGHT,
  CAPTION_MAX_FONT_SCALE,
  captionCharBudget,
  captionStripMinHeight,
  captionTail
} from './dictation-caption-tail'
import {
  useMobileDictationCaption,
  type MobileDictationCaptionStore
} from '../hooks/mobile-dictation-caption-store'

export type MobileDictationCaptionState = {
  readonly isRecording: boolean
  readonly isProcessing: boolean
  readonly captionStore?: MobileDictationCaptionStore
}

type Props = {
  dictation: MobileDictationCaptionState
  /** 'dock' sits flush between the terminal accessory bar and input bar; 'card' floats above the chat composer. */
  variant: 'dock' | 'card'
}

/** Shows what the desktop is hearing while the mic is open. Never writes into a TextInput: iOS
 *  drops the IME when JS rewrites a focused field, so the caption stays display-only. */
export function MobileDictationCaptionStrip({ dictation, variant }: Props) {
  const { fontScale } = useWindowDimensions()
  const [captionWidth, setCaptionWidth] = useState(0)
  const liveCaption = useMobileDictationCaption(dictation.captionStore)
  if (!dictation.isRecording && !dictation.isProcessing) {
    return null
  }
  const caption = dictation.isRecording
    ? captionTail(liveCaption, captionCharBudget(captionWidth, typography.bodySize, fontScale))
    : ''
  const onCaptionLayout = (event: LayoutChangeEvent) => {
    setCaptionWidth(event.nativeEvent.layout.width)
  }
  return (
    <View
      style={[
        styles.strip,
        // Why: reserve both caption lines at the Dynamic Type size so the strip doesn't jump.
        { minHeight: captionStripMinHeight(fontScale) },
        variant === 'dock' ? styles.dock : styles.card
      ]}
      testID="dictation-caption-strip"
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      {dictation.isRecording ? (
        <RecordingDot />
      ) : (
        <ActivityIndicator size="small" color={colors.textMuted} style={styles.spinner} />
      )}
      {caption ? (
        <Text
          style={styles.caption}
          numberOfLines={2}
          maxFontSizeMultiplier={CAPTION_MAX_FONT_SCALE}
          // Why: iOS head-ellipsizes multi-line text natively; Android only honours tail there.
          ellipsizeMode={Platform.OS === 'ios' ? 'head' : 'tail'}
          onLayout={onCaptionLayout}
        >
          {caption}
        </Text>
      ) : (
        <Text
          style={styles.status}
          numberOfLines={1}
          maxFontSizeMultiplier={CAPTION_MAX_FONT_SCALE}
          onLayout={onCaptionLayout}
        >
          {dictation.isRecording ? 'Listening…' : 'Transcribing…'}
        </Text>
      )}
    </View>
  )
}

function RecordingDot() {
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true })
      ])
    )
    pulse.start()
    return () => pulse.stop()
  }, [opacity])
  return <Animated.View style={[styles.dot, { opacity }]} />
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  dock: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  card: {
    marginBottom: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.statusRed
  },
  spinner: { width: 8, transform: [{ scale: 0.7 }] },
  caption: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    lineHeight: CAPTION_LINE_HEIGHT
  },
  status: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
})
