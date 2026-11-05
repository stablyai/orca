import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { triggerMediumImpact } from '../../../platform/haptics'
import { MobileNativeChatImageViewer } from '../visual/MobileNativeChatImageViewer'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'
import {
  MobileNativeChatRowOverlaysContext,
  type MobileNativeChatViewedImage
} from './mobile-native-chat-row-overlays'
import {
  useMobileNativeChatConversationState,
  type MobileNativeChatConversation
} from '../use-mobile-native-chat-conversation-state'
import type { MobileNativeChatImageSource } from '../visual/mobile-native-chat-image-preview'

export function MobileNativeChatRowOverlaysHost({
  conversation,
  imageSource,
  onQuote,
  children
}: {
  conversation: MobileNativeChatConversation
  imageSource?: MobileNativeChatImageSource
  onQuote?: (text: string) => void
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
      openActions: (actionsFor: NativeChatMessage) => {
        triggerMediumImpact()
        setShown({ actionsFor })
      },
      imageSource,
      quote: onQuote
    }),
    [setShown, imageSource, onQuote]
  )
  // Memoize overlay callbacks so streamed words cannot rebuild them.
  const opened = useMemo(() => {
    const close = () => setShown(null)
    return shown?.image ? (
      <MobileNativeChatImageViewer {...shown.image} onClose={close} />
    ) : shown?.actionsFor ? (
      <MobileNativeChatMessageActionsSheet
        message={shown.actionsFor}
        onQuote={shown.actionsFor.role === 'assistant' ? onQuote : undefined}
        onClose={close}
      />
    ) : null
  }, [shown, setShown, onQuote])
  return (
    <MobileNativeChatRowOverlaysContext.Provider value={overlays}>
      {children}
      {opened}
    </MobileNativeChatRowOverlaysContext.Provider>
  )
}
