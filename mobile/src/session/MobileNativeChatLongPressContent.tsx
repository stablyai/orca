import type { ComponentProps, ReactNode } from 'react'
import { Pressable, View } from 'react-native'

/** A message body that opens the actions sheet on long press (Android, which has no inline
 *  selection); elsewhere a plain view, so a held press selects text natively. */
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
