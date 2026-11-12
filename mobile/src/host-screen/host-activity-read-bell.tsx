import { ActivityIndicator, Pressable } from 'react-native'
import { Bell, CircleHelp } from 'lucide-react-native'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function HostActivityReadBell({
  unread,
  disabled,
  pending,
  onChange
}: {
  unread: boolean | undefined
  disabled: boolean
  pending: boolean
  onChange: (read: boolean) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const label =
    unread === undefined
      ? t('hostScreen.activity.readUnavailable', 'Notification read status unavailable')
      : unread
        ? t('hostScreen.activity.markRead', 'Mark activity read')
        : t('hostScreen.activity.markUnread', 'Mark activity unread')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || pending || unread === undefined, busy: pending }}
      disabled={disabled || pending || unread === undefined}
      hitSlop={6}
      style={({ pressed }) => [styles.button, pressed && pressedStyle]}
      onPress={(event) => {
        event.stopPropagation()
        onChange(unread === true)
      }}
    >
      {pending ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : unread === undefined ? (
        <CircleHelp size={18} color={colors.textMuted} />
      ) : (
        <Bell
          size={18}
          color={unread ? colors.statusAmber : colors.textMuted}
          fill={unread ? colors.statusAmber : 'none'}
        />
      )}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto'
  }
}))
