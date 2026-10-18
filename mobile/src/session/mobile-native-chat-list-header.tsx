import type { ReactElement } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import type { OlderPagePhase } from './use-mobile-older-page-loader'

const LOAD_EARLIER_FAILED = "Couldn't load earlier messages. Tap to try again."
const EARLIER_UNAVAILABLE = "Earlier messages can't be loaded."

/** The "Load earlier messages" control, while older history remains. `measuring`: the page has loaded
 *  rows above it still to draw, so it shows loading until they are in. */
export function mobileNativeChatListHeader(
  hasMore: boolean | undefined,
  olderPages: OlderPagePhase | undefined,
  loadEarlier: () => void,
  measuring = false
): ReactElement | null {
  if (olderPages === 'unavailable' && !measuring) {
    // No retry gets past it, so the control gives way to a line that says so.
    return (
      <View style={styles.loadEarlier}>
        <Text style={styles.loadEarlierFailedText}>{EARLIER_UNAVAILABLE}</Text>
      </View>
    )
  }
  if (!hasMore && !measuring) {
    return null
  }
  const loadingEarlier = measuring || olderPages === 'loading'
  return (
    <Pressable style={styles.loadEarlier} onPress={loadEarlier} disabled={loadingEarlier}>
      {loadingEarlier ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : (
        <Text style={styles.loadEarlierText}>Load earlier messages</Text>
      )}
      {olderPages === 'failed' ? (
        <Text style={styles.loadEarlierFailedText}>{LOAD_EARLIER_FAILED}</Text>
      ) : null}
    </Pressable>
  )
}
