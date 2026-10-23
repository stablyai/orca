import { StyleSheet, Text, View } from 'react-native'
import { colors, textStyles, typography } from '../theme/mobile-theme'

type DictationStatus = {
  readonly isStarting: boolean
  readonly isRecording: boolean
  readonly isProcessing: boolean
}

type MobileTerminalLiveInputStatusProps = {
  readonly dictation: DictationStatus
  readonly isAttaching: boolean
  readonly liveInputText: string
}

export function MobileTerminalLiveInputStatus({
  dictation,
  isAttaching,
  liveInputText
}: MobileTerminalLiveInputStatusProps) {
  const title = dictation.isRecording
    ? 'Listening'
    : dictation.isProcessing
      ? 'Processing'
      : dictation.isStarting
        ? 'Starting mic'
        : 'Live input'
  const detail = dictation.isRecording
    ? 'Tap mic to stop'
    : dictation.isProcessing
      ? 'Transcribing on desktop'
      : dictation.isStarting
        ? 'Preparing microphone'
        : isAttaching
          ? 'Uploading image to desktop'
          : liveInputText || 'Tap to show keyboard'
  const showsTypedText =
    !dictation.isRecording &&
    !dictation.isProcessing &&
    !dictation.isStarting &&
    !isAttaching &&
    liveInputText.length > 0

  return (
    <View style={styles.status}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text
        style={[styles.detail, showsTypedText && styles.typed]}
        numberOfLines={1}
        ellipsizeMode="head"
      >
        {detail}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  status: {
    flex: 1,
    minWidth: 0
  },
  title: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.textPrimary
  },
  detail: {
    ...textStyles.footnote,
    color: colors.textSecondary
  },
  typed: { fontFamily: typography.monoFamily }
})
