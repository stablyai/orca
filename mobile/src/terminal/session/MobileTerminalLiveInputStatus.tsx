import { useContext, type RefObject } from 'react'
import { Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { themedStyleSheet } from '../../theme/themed-styles'
import { TailClippedText } from '../../components/TailClippedText'
import {
  mobileDictationStatusTitle,
  type MobileDictationStatusFlags
} from '../../dictation/MobileDictationStatusAnnouncement'
import { MobileDictationLiveContext } from '../../dictation/mobile-dictation-live-context'
import {
  MobileDictationCancelButton,
  MobileDictationFailureNote,
  MobileDictationFinishingNote,
  MobileDictationRecordingMeter
} from '../../dictation/MobileDictationLiveControls'

type MobileTerminalLiveInputStatusProps = {
  readonly dictation: MobileDictationStatusFlags
  readonly cancelRef: RefObject<View | null>
  readonly dictationMode: string | undefined
  readonly isAttaching: boolean
  // Words heard so far that will be typed into this terminal.
  readonly heard: string
}

/** Shows transient recording/upload status over the field; only its ✕ takes touches. */
export function MobileTerminalLiveInputStatus({
  dictation,
  cancelRef,
  dictationMode,
  isAttaching,
  heard
}: MobileTerminalLiveInputStatusProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const live = useContext(MobileDictationLiveContext)
  const dictationTitle = mobileDictationStatusTitle(dictation)
  if (live?.failureReason != null) {
    return (
      <View style={[styles.status, styles.dictating]} pointerEvents="box-none">
        <MobileDictationCancelButton onCancel={live.cancel} compact discards />
        <View style={styles.dictationLine} pointerEvents="none">
          <MobileDictationFailureNote reason={live.failureReason} compact />
        </View>
      </View>
    )
  }
  if (!dictationTitle) {
    return isAttaching ? (
      <View style={styles.status} pointerEvents="none">
        <Text style={styles.title} numberOfLines={1}>
          {t('session.terminalLiveInputStatus.uploadingImageTitle', 'Uploading image')}
        </Text>
        <View style={styles.detailLine}>
          <TailClippedText style={styles.detail}>
            {t('session.terminalLiveInputStatus.uploadingImage', 'Uploading image to host')}
          </TailClippedText>
        </View>
      </View>
    ) : null
  }
  // Live input can't type into the terminal until the text is final, so the newest words show here.
  const detail =
    heard ||
    (dictation.isRecording
      ? dictationMode === 'hold'
        ? t('session.terminalLiveInputStatus.releaseMicHint', 'Release mic to stop')
        : dictationTitle
      : dictation.isStarting
        ? t('session.terminalLiveInputStatus.preparingMic', 'Preparing microphone')
        : '')
  return (
    <View style={[styles.status, styles.dictating]} pointerEvents="box-none">
      {live ? (
        <MobileDictationCancelButton onCancel={live.cancel} targetRef={cancelRef} compact />
      ) : null}
      <View style={styles.dictationLine} pointerEvents="none">
        <View style={styles.detailLine}>
          <TailClippedText style={heard ? [styles.detail, styles.heard] : styles.detail}>
            {detail}
          </TailClippedText>
        </View>
        {live === null ? null : dictation.isRecording ? (
          <MobileDictationRecordingMeter
            meter={live.meter}
            engine={live.engine}
            computerName={live.computerName}
            dotSize={3.5}
          />
        ) : dictation.isProcessing ? (
          <MobileDictationFinishingNote engine={live.engine} computerName={live.computerName} />
        ) : null}
      </View>
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
  // The ✕ hugs the field's left edge, the way the mock's cancel sits in the pill.
  dictating: {
    paddingLeft: 4
  },
  dictationLine: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
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
