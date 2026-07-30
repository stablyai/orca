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
}

export function MobileTerminalLiveInputStatus({
  dictation,
  isAttaching
}: MobileTerminalLiveInputStatusProps) {
  const title = dictation.isRecording
    ? t('m.y6GQnVA')
    : dictation.isProcessing
      ? t('m.Q7SP9fo')
      : dictation.isStarting
        ? t('m._MGGD5E')
        : t('m.kbozpKo')
  const detail = dictation.isRecording
    ? t('m.GGXoono')
    : dictation.isProcessing
      ? t('m._-dmI2A')
      : dictation.isStarting
        ? t('m.ha7j7qM')
        : isAttaching
          ? t('m.quM4RwQ')
          : t('m.7IfxObc')

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
