import { StyleSheet, Text, View } from 'react-native'
import { colors, typography } from '../theme/mobile-theme'
import { t } from '@/i18n/mobile-i18n'

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
    ? t('mobileTerminalLiveInputStatus.listening')
    : dictation.isProcessing
      ? t('mobileTerminalLiveInputStatus.processing')
      : dictation.isStarting
        ? t('mobileTerminalLiveInputStatus.starting')
        : t('mobileTerminalLiveInputStatus.live')
  const detail = dictation.isRecording
    ? t('mobileTerminalLiveInputStatus.tapMic')
    : dictation.isProcessing
      ? t('mobileTerminalLiveInputStatus.transcribing')
      : dictation.isStarting
        ? t('mobileTerminalLiveInputStatus.preparing')
        : isAttaching
          ? t('mobileTerminalLiveInputStatus.uploading')
          : liveInputText || t('mobileTerminalLiveInputStatus.tapShow')

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
  }
})
