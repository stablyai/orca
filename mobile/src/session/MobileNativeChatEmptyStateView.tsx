import { Text, View } from 'react-native'
import type { NativeChatEmptyStateCopy } from '../../../src/shared/native-chat/native-chat-empty-state'
import { styles } from './mobile-native-chat-view-styles'

export function MobileNativeChatEmptyStateView({ copy }: { copy: NativeChatEmptyStateCopy }) {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{copy.title}</Text>
      <Text style={styles.emptySubtitle}>{copy.subtitle}</Text>
    </View>
  )
}
