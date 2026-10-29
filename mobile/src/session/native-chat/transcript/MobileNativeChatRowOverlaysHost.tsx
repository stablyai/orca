import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { MobileNativeChatImageViewer } from '../visual/MobileNativeChatImageViewer'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'
import {
  MobileNativeChatRowOverlaysContext,
  type MobileNativeChatViewedImage
} from './mobile-native-chat-row-overlays'
import {
  useMobileNativeChatConversationState,
  type MobileNativeChatConversation
} from '../../use-mobile-native-chat-conversation-state'
import type { MobileNativeChatImageSource } from '../visual/mobile-native-chat-image-preview'

export function MobileNativeChatRowOverlaysHost({
  conversation,
  imageSource,
  children
}: {
  conversation: MobileNativeChatConversation
  imageSource?: MobileNativeChatImageSource
  children?: React.ReactNode
}): React.JSX.Element {
  // Keep pressed message text with its conversation so streaming cannot rewrite an open sheet.
  const [shown, setShown] = useMobileNativeChatConversationState<{
    image?: MobileNativeChatViewedImage
    actionsFor?: NativeChatMessage
  }>(conversation)
  const overlays = useMemo(
    () => ({
      openImage: (image: MobileNativeChatViewedImage) => setShown({ image }),
      openActions: (actionsFor: NativeChatMessage) => setShown({ actionsFor }),
      imageSource
    }),
    [setShown, imageSource]
  )
  // Memoize overlay callbacks so streamed words cannot rebuild them.
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
