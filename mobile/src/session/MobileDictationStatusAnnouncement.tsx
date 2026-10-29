import { StyleSheet, Text, View } from 'react-native'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'

export type MobileDictationStatusFlags = Pick<
  UseMobileDictationResult,
  'isStarting' | 'isRecording' | 'isProcessing'
>

export function mobileDictationStatusTitle(dictation: MobileDictationStatusFlags): string | null {
  return dictation.isRecording
    ? 'Listening'
    : dictation.isProcessing
      ? 'Processing'
      : dictation.isStarting
        ? 'Starting mic'
        : null
}

// Mic labels change silently; one live region tells screen readers for every mic, like desktop's indicator.
export function MobileDictationStatusAnnouncement({
  dictation
}: {
  dictation: MobileDictationStatusFlags
}): React.JSX.Element {
  return (
    <View style={styles.hidden} pointerEvents="none" accessibilityLiveRegion="polite">
      <Text>{mobileDictationStatusTitle(dictation) ?? ''}</Text>
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
