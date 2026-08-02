import { StyleSheet, Text, View } from 'react-native'
import { colors, typography } from '../theme/mobile-theme'

type DictationStatus = {
  readonly isStarting: boolean
  readonly isRecording: boolean
  readonly isProcessing: boolean
}

type MobileTerminalLiveInputStatusProps = {
  readonly dictation: DictationStatus
  readonly isAttaching: boolean
}

export function MobileTerminalLiveInputStatus({
  dictation,
  isAttaching
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
          ? 'Uploading image to host'
          : 'Tap to show keyboard'

  return (
    <View style={styles.status}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.detail} numberOfLines={1}>
        {detail}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  status: {
    flex: 1,
    gap: 1
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  detail: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  }
})
