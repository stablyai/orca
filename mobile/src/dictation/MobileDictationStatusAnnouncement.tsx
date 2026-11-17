import { StyleSheet, Text, View } from 'react-native'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { translate } from '../i18n/mobile-i18n'
import type { MobileDictationLiveText } from './use-mobile-dictation-announcements'

export type MobileDictationStatusFlags = Pick<
  UseMobileDictationResult,
  'isStarting' | 'isRecording' | 'isProcessing'
>

export function mobileDictationStatusTitle(dictation: MobileDictationStatusFlags): string | null {
  return dictation.isRecording
    ? translate('session.terminalLiveInputStatus.listening', 'Listening')
    : dictation.isProcessing
      ? translate('session.terminalLiveInputStatus.processing', 'Processing')
      : dictation.isStarting
        ? translate('session.terminalLiveInputStatus.startingMic', 'Starting mic')
        : null
}

// The live region for announcements the shell could not speak itself (TalkBack reads it; older shells fall back to it).
// A new Text per message, so the same words twice are read twice.
export function MobileDictationStatusAnnouncement({
  liveText
}: {
  liveText: MobileDictationLiveText
}): React.JSX.Element {
  return (
    <View style={styles.hidden} pointerEvents="none" accessibilityLiveRegion="polite">
      <Text key={liveText.id}>{liveText.text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    opacity: 0
  }
})
