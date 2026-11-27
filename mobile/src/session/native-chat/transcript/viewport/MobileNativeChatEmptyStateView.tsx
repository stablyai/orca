import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import type { NativeChatEmptyStateCopy } from '../../../../../../src/shared/native-chat/native-chat-empty-state'
import { styles } from '../../mobile-native-chat-view-styles'

export function MobileNativeChatEmptyStateView({
  copy,
  picture
}: {
  copy: NativeChatEmptyStateCopy
  /** Who the chat is with, above its title. */
  picture?: ReactNode
}) {
  return (
    <View style={styles.center}>
      {picture ? <View style={styles.emptyPicture}>{picture}</View> : null}
      <Text style={styles.emptyTitle}>{copy.title}</Text>
      <Text style={styles.emptySubtitle}>{copy.subtitle}</Text>
    </View>
  )
}
