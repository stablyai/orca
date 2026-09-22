import { Pressable, Text } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'

/**
 * Dropping the pairing, from the banner that reports it failing.
 *
 * Its own file because its `.web` sibling renders nothing: removal is native-only, so on the page
 * this control could only refuse. Retry and Re-pair stay, because both still do something there.
 */
export function AuthFailedRemoveAction({ onPress }: { onPress: () => void }) {
  return (
    <Pressable style={styles.action} onPress={onPress}>
      <Text style={[styles.actionText, { color: colors.statusRed }]}>Remove</Text>
    </Pressable>
  )
}
