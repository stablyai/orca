import { Text } from 'react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { voiceSettingsStyles } from './voice-settings-styles'
import { voiceCabinetStyles as styles } from './voice-cabinet-styles'
import {
  SpeechModelGroupedList,
  type SpeechModelGroupedListProps
} from './speech-model-grouped-list'

export type { SpeechModelBusy } from './speech-model-grouped-list'

type Props = SpeechModelGroupedListProps & {
  visible: boolean
  onClose: () => void
}

export function SpeechModelPickerDrawer({ visible, onClose, ...listProps }: Props) {
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <Text style={voiceSettingsStyles.drawerTitle}>Choose a model</Text>
      <Text style={styles.drawerSubtitle}>Models marked LIVE show captions while you speak.</Text>
      <SpeechModelGroupedList {...listProps} />
    </BottomDrawer>
  )
}
