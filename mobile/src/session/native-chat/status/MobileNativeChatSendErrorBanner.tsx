import { Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { pressedStyle } from '../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { stylesSheet } from '../mobile-native-chat-view-styles'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../../../theme/themed-styles'

export function MobileNativeChatSendErrorBanner({
  message,
  onDismiss
}: {
  message?: string | null
  /** Present for an error that stays until dismissed, such as a failed Continue. */
  onDismiss?: () => void
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  if (!message) {
    return null
  }
  return (
    // This banner is the only channel for a send failure — announce it.
    <View style={styles.sendError} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <View style={styles.sendErrorRow}>
        <Text style={styles.sendErrorText}>{message}</Text>
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.sendError.dismiss', 'Dismiss')}
            hitSlop={8}
            onPress={onDismiss}
            style={({ pressed }) => pressed && pressedStyle}
          >
            <X size={14} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}
