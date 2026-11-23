import type { ComponentProps } from 'react'
import { View } from 'react-native'
import { MobileNativeChatGroupedThought } from '../message-content/MobileNativeChatReasoningRow'
import { MobileNativeChatNoticeRow } from '../notices/MobileNativeChatNoticeRow'

export function MobileNativeChatWorkRunAside(
  props: ComponentProps<typeof MobileNativeChatGroupedThought>
): React.JSX.Element {
  return props.message.role === 'system' ? (
    <View>
      <MobileNativeChatNoticeRow
        blocks={props.message.blocks}
        disclosed
        fontScale={props.fontScale}
      />
    </View>
  ) : (
    <MobileNativeChatGroupedThought {...props} />
  )
}
