import type { ComponentProps, ReactNode } from 'react'
import { Pressable, View } from 'react-native'

/** A message body that opens the actions sheet on long press (Android, which has no inline
 *  selection). Keep the existing responder hierarchy on platforms with inline selection. */
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
    <Pressable onLongPress={onLongPress} style={style}>
      {children}
    </Pressable>
  ) : (
    <View style={style}>{children}</View>
  )
}
