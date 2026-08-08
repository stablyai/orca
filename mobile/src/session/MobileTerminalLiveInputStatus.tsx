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
  readonly liveInputText: string
  // Why: marking IMEs (Japanese kana, pinyin) withhold bytes until commit, so the
  // terminal echo shows nothing mid-composition and this dock is the only preview.
  // Empties on commit by design — the terminal echo takes over from there.
  readonly composingText?: string
}

export function MobileTerminalLiveInputStatus({
  dictation,
  isAttaching,
  liveInputText,
  composingText = ''
}: MobileTerminalLiveInputStatusProps) {
  if (composingText.length > 0) {
    return (
      <View style={styles.status}>
        <Text style={styles.title} numberOfLines={1}>
          Composing
        </Text>
        <Text style={styles.composing} numberOfLines={1} ellipsizeMode="head">
          {composingText}
        </Text>
      </View>
    )
  }

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
          : liveInputText || 'Tap to show keyboard'

  return (
    <View style={styles.status}>
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
  },
  // Underlined uncommitted text is the platform convention for marked text on both
  // iOS and Android; brighter than `detail` because it is live content, not chrome.
  composing: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    textDecorationLine: 'underline'
  }
})
