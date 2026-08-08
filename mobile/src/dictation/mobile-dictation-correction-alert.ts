import { Alert } from 'react-native'
import type { MobileDictationTranscriptPreview } from '../hooks/mobile-dictation-session-state'

export function showMobileDictationCorrectionAlert(
  preview: MobileDictationTranscriptPreview,
  onInsert: (text: string) => void,
  onDiscard: () => void
): void {
  Alert.alert(
    'Review dictation correction',
    `${preview.correctedText}\n\nOriginal:\n${preview.rawText}`,
    [
      { text: 'Discard', style: 'cancel', onPress: onDiscard },
      { text: 'Use original', onPress: () => onInsert(preview.rawText) },
      { text: 'Insert corrected', onPress: () => onInsert(preview.correctedText) }
    ],
    { cancelable: true, onDismiss: onDiscard }
  )
}
