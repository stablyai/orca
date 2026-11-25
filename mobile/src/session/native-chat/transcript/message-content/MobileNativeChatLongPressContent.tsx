import type { ComponentProps, ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { styles } from '../messages/mobile-native-chat-message-styles'

// Android uses a message-actions long press; other platforms keep native inline selection.
export function MobileNativeChatLongPressContent({
  onLongPress,
  notice,
  noticeActionLabel,
  style,
  children
}: {
  onLongPress?: () => void
  notice?: string
  noticeActionLabel?: string
  style: ComponentProps<typeof View>['style']
  children: ReactNode
}): React.JSX.Element {
  const body = onLongPress ? (
    // Not one accessible element: screen readers keep reaching the text and controls inside.
    <Pressable onLongPress={onLongPress} accessible={false} style={style}>
      {children}
    </Pressable>
  ) : (
    <View style={style}>{children}</View>
  )
  if (!notice) {
    return body
  }
  const label = (
    <Text style={noticeActionLabel ? styles.mutedNotice : styles.unsentNotice}>{notice}</Text>
  )
  return (
    <View style={styles.deliveryBody}>
      {body}
      {noticeActionLabel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={notice}
          accessibilityHint={noticeActionLabel}
          onPress={onLongPress}
        >
          {label}
        </Pressable>
      ) : (
        label
      )}
    </View>
  )
}
