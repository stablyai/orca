import { useContext, type RefObject } from 'react'
import { Text, View, type HostInstance } from 'react-native'
import { radii, spacing, typography } from '../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { themedStyleSheet, useThemedStyles } from '../../../theme/themed-styles'
import { TailClippedText } from '../../../components/list/TailClippedText'
import {
  mobileDictationStatusTitle,
  type MobileDictationStatusFlags
} from '../../../dictation/MobileDictationStatusAnnouncement'
import { MobileDictationLiveContext } from '../../../dictation/mobile-dictation-live-context'
import {
  MobileDictationCancelButton,
  MobileDictationFailureNote,
  MobileDictationFinishingNote,
  MobileDictationRecordingMeter
} from '../../../dictation/MobileDictationLiveControls'

type MobileTerminalLiveInputStatusProps = {
  readonly dictation: MobileDictationStatusFlags
  readonly cancelRef: RefObject<HostInstance | null>
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
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const live = useContext(MobileDictationLiveContext)
  const dictationTitle = mobileDictationStatusTitle(dictation, t)
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
        <Text style={styles.uploading} numberOfLines={1}>
          {t('session.terminalLiveInputStatus.uploading', 'Uploading…')}
        </Text>
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

const stylesSheet = themedStyleSheet((colors) => ({
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
    // The field's own corners, so the cover lines up with the edge it sits on.
    borderRadius: radii.control,
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
  uploading: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.bodySize
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
