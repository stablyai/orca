import { Pressable, Text, View } from 'react-native'
import { pressedStyle } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { authFailedBannerStyles as styles } from './auth-failed-banner-styles'
import { useDesktopLinkPairingCopy } from './desktop-link-pairing-copy'

/** A phone paired with a desktop link stays connected, but its host shows it no chats until it pairs again. */
export function DesktopLinkPairingBanner({ onRepair }: { onRepair: () => void }) {
  useMobileColorScheme()
  const copy = useDesktopLinkPairingCopy()
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>{copy.message}</Text>
      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.action, pressed && pressedStyle]}
          onPress={onRepair}
          accessibilityRole="button"
        >
          <Text style={styles.actionText}>{copy.repair}</Text>
        </Pressable>
      </View>
    </View>
  )
}
