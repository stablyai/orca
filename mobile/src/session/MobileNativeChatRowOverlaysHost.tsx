import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatImageViewer } from './MobileNativeChatImageViewer'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'
import {
  MobileNativeChatRowOverlaysContext,
  type MobileNativeChatViewedImage
} from './mobile-native-chat-row-overlays'
import {
  useMobileNativeChatConversationState,
  type MobileNativeChatConversation
} from './use-mobile-native-chat-conversation-state'

/** The chat surface, from which any row can open a picture full size or its actions sheet. */
export function MobileNativeChatRowOverlaysHost({
  conversation,
  children
}: {
  conversation: MobileNativeChatConversation
  children?: React.ReactNode
}): React.JSX.Element {
  // What a row opened belongs to the conversation it was opened in. The message is kept as it was
  // pressed, so the sheet reads its words once.
  const [shown, setShown] = useMobileNativeChatConversationState<{
    image?: MobileNativeChatViewedImage
    actionsFor?: NativeChatMessage
  }>(conversation)
  const overlays = useMemo(
    () => ({
      openImage: (image: MobileNativeChatViewedImage) => setShown({ image }),
      openActions: (actionsFor: NativeChatMessage) => setShown({ actionsFor })
    }),
    [setShown]
  )
  // Built once per change, so the chat re-rendering on each streamed word leaves it alone.
  const opened = useMemo(() => {
    const close = () => setShown(null)
    return shown?.image ? (
      <MobileNativeChatImageViewer {...shown.image} onClose={close} />
    ) : shown?.actionsFor ? (
      <MobileNativeChatMessageActionsSheet message={shown.actionsFor} onClose={close} />
    ) : null
  }, [shown, setShown])
  return (
    <MobileNativeChatRowOverlaysContext.Provider value={overlays}>
      {children}
      {opened}
    </MobileNativeChatRowOverlaysContext.Provider>
  )
}
