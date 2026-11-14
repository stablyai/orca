import type { ComponentProps } from 'react'
import { MobileMarkdown } from '../../../../components/MobileMarkdown'
import { useMobileNativeChatOpenFile } from '../../links/mobile-native-chat-open-file-context'

/** Chat markdown: generic markdown with the chat's file opener, so file paths in any chat text open,
 *  and desktop chat's math delimiters. */
export function MobileNativeChatMarkdown(
  props: Omit<ComponentProps<typeof MobileMarkdown>, 'onOpenFile' | 'chatMath'>
): React.JSX.Element {
  return <MobileMarkdown {...props} chatMath onOpenFile={useMobileNativeChatOpenFile()} />
}
