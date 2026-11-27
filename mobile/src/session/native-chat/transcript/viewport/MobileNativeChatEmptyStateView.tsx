import type { ReactNode } from 'react'
import type { NativeChatEmptyStateCopy } from '../../../../../../src/shared/native-chat/native-chat-empty-state'
import { MobileStateView } from '../../../../components/feedback/MobileStateView'

/** The app's state view for a chat with nothing to show: a title, and one sentence when it helps. */
export function MobileNativeChatEmptyStateView({
  copy,
  picture
}: {
  copy: NativeChatEmptyStateCopy
  /** Who the chat is with, above its title. */
  picture?: ReactNode
}) {
  return (
    <MobileStateView iconElement={picture} title={copy.title} message={copy.subtitle || null} />
  )
}
