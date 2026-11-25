import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, pressedStyle } from '../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { styles } from '../mobile-native-chat-view-styles'
import { useAccessibilityAnnouncer } from '../../../platform/accessibility/accessibility-announcer'

export function MobileNativeChatSendErrorBanner({
  message,
  onDismiss
}: {
  message?: string | null
  /** Present for an error that stays until dismissed, such as a failed Continue. */
  onDismiss?: () => void
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const announce = useAccessibilityAnnouncer()
  const announced = useRef<string | null>(null)
  const [liveMessage, setLiveMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!message) {
      announced.current = null
      setLiveMessage(null)
      return
    }
    if (announced.current === message) {
      return
    }
    announced.current = message
    void announce(message).then((spoken) => {
      if (!spoken && announced.current === message) {
        setLiveMessage(message)
      }
    })
  }, [announce, message])
  if (!message) {
    return null
  }
  return (
    <View
      style={styles.sendError}
      accessibilityRole={liveMessage === message ? 'alert' : undefined}
      accessibilityLiveRegion={liveMessage === message ? 'assertive' : 'none'}
    >
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
