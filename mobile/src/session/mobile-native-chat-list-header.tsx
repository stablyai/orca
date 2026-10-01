import type { ReactElement } from 'react'
import { ActivityIndicator, Pressable, Text } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'

/** The "Load earlier messages" affordance pinned above the transcript. */
export function mobileNativeChatListHeader({
  hasMore,
  loadingEarlier,
  onLoadEarlier
}: {
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier: () => void
}): ReactElement | null {
  if (!hasMore) {
    return null
  }
  return (
    <Pressable style={styles.loadEarlier} onPress={onLoadEarlier} disabled={loadingEarlier}>
      {loadingEarlier ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : (
        <Text style={styles.loadEarlierText}>Load earlier messages</Text>
      )}
    </Pressable>
  )
}
