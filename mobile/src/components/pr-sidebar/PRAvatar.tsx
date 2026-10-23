import { Image, Text, View } from 'react-native'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

/**
 * A person's avatar: their initial, with the provider image over it once it loads. The page's
 * img-src admits https:, and on an older shell that still refuses it the initial stays visible.
 */
export function PRAvatar({ login, url }: { login: string; url?: string | null }) {
  return (
    <View style={styles.avatar} accessible={false}>
      <Text style={styles.avatarInitial}>{login.slice(0, 1).toUpperCase()}</Text>
      {url ? <Image source={{ uri: url }} style={styles.avatarImage} /> : null}
    </View>
  )
}
