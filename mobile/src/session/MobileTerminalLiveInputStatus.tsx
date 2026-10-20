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

/** Shows transient recording/upload status without intercepting touches meant for live input. */
export function MobileTerminalLiveInputStatus({
  dictation,
  isAttaching
}: MobileTerminalLiveInputStatusProps) {
  if (!dictation.isRecording && !dictation.isProcessing && !dictation.isStarting && !isAttaching) {
    return null
  }
  const title = dictation.isRecording
    ? 'Listening'
    : dictation.isProcessing
      ? 'Processing'
      : dictation.isStarting
        ? 'Starting mic'
        : 'Uploading image'
  const detail = dictation.isRecording
    ? 'Tap mic to stop'
    : dictation.isProcessing
      ? 'Transcribing on desktop'
      : dictation.isStarting
        ? 'Preparing microphone'
        : 'Uploading image to host'

  return (
    <View style={styles.status} pointerEvents="none">
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.detail} numberOfLines={1} ellipsizeMode="head">
        {detail}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  status: {
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
