import { Text, View } from 'react-native'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { themedStyleSheet } from '../theme/themed-styles'
import { TailClippedText } from '../components/TailClippedText'
import {
  mobileDictationStatusTitle,
  type MobileDictationStatusFlags
} from './MobileDictationStatusAnnouncement'
import { MobileDictationGrapes, MobileDictationTimer } from './MobileDictationMeter'

type MobileTerminalLiveInputStatusProps = {
  readonly dictation: MobileDictationStatusFlags & Pick<UseMobileDictationResult, 'meter'>
  readonly dictationMode: string | undefined
  readonly isAttaching: boolean
  // Words heard so far that will be typed into this terminal.
  readonly heard: string
}

/** Shows transient recording/upload status over the field without intercepting its touches. */
export function MobileTerminalLiveInputStatus({
  dictation,
  dictationMode,
  isAttaching,
  heard
}: MobileTerminalLiveInputStatusProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const dictationTitle = mobileDictationStatusTitle(dictation)
  if (!dictationTitle && !isAttaching) {
    return null
  }
  const title =
    dictationTitle ?? t('session.terminalLiveInputStatus.uploadingImageTitle', 'Uploading image')
  // Live input can't type into the terminal until the text is final, so the newest words show here.
  const detail =
    heard ||
    (dictation.isRecording
      ? dictationMode === 'hold'
        ? t('session.terminalLiveInputStatus.releaseMicHint', 'Release mic to stop')
        : t('session.terminalLiveInputStatus.stopHint', 'Tap mic to stop')
      : dictation.isProcessing
        ? t('session.terminalLiveInputStatus.transcribing', 'Transcribing on desktop')
        : dictation.isStarting
          ? t('session.terminalLiveInputStatus.preparingMic', 'Preparing microphone')
          : t('session.terminalLiveInputStatus.uploadingImage', 'Uploading image to host'))

  return (
    <View style={styles.status} pointerEvents="none">
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {dictation.isRecording ? <MobileDictationTimer meter={dictation.meter} /> : null}
      <View style={styles.detailLine}>
        <TailClippedText style={heard ? [styles.detail, styles.heard] : styles.detail}>
          {detail}
        </TailClippedText>
      </View>
      {dictation.isRecording ? (
        <MobileDictationGrapes meter={dictation.meter} dotSize={3.5} />
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // Cover the field in place so the dock, and with it the PTY, keeps its height.
  status: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  detailLine: {
    flex: 1
  },
  detail: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  heard: {
    color: colors.textPrimary
  }
}))
