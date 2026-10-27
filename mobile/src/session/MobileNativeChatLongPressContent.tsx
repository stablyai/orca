import type { ComponentProps, ReactNode } from 'react'
import { Pressable, View } from 'react-native'

// Android uses a message-actions long press; other platforms keep native inline selection.
export function MobileNativeChatLongPressContent({
  onLongPress,
  style,
  children
}: {
  onLongPress?: () => void
  style: ComponentProps<typeof View>['style']
  children: ReactNode
}): React.JSX.Element {
  return onLongPress ? (
    // Not one accessible element: screen readers keep reaching the text and controls inside.
    <Pressable onLongPress={onLongPress} accessible={false} style={style}>
      {children}
    </Pressable>
  ) : (
    <View style={style}>{children}</View>
  )
}
