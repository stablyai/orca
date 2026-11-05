import { useCallback, useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { triggerMediumImpact } from '../../../platform/haptics'
import { MobileNativeChatImageViewer } from '../visual/MobileNativeChatImageViewer'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'
import { MobileLinkActionSheet } from '../../MobileLinkActionSheet'
import { MarkdownLinkHandlerContext } from '../../../components/markdown-link-handler'
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
  onOpenUrlInOrca,
  showToast,
  children
}: {
  conversation: MobileNativeChatConversation
  imageSource?: MobileNativeChatImageSource
  /** Absent where the host can't open a browser tab for this chat. */
  onOpenUrlInOrca?: (url: string) => void
  showToast: (message: string, durationMs?: number) => void
  children?: React.ReactNode
}): React.JSX.Element {
  // Keep pressed message text with its conversation so streaming cannot rewrite an open sheet.
  const [shown, setShown] = useMobileNativeChatConversationState<{
    image?: MobileNativeChatViewedImage
    actionsFor?: NativeChatMessage
    link?: string
  }>(conversation)
  const overlays = useMemo(
    () => ({
      openImage: (image: MobileNativeChatViewedImage) => setShown({ image }),
      openActions: (actionsFor: NativeChatMessage) => {
        triggerMediumImpact()
        setShown({ actionsFor })
      },
      imageSource
    }),
    [setShown, imageSource]
  )
  const openLink = useCallback((link: string) => setShown({ link }), [setShown])
  // Memoize overlay callbacks so streamed words cannot rebuild them.
  const opened = useMemo(() => {
    const close = () => setShown(null)
    return shown?.image ? (
      <MobileNativeChatImageViewer {...shown.image} onClose={close} />
    ) : shown?.actionsFor ? (
      <MobileNativeChatMessageActionsSheet message={shown.actionsFor} onClose={close} />
    ) : shown?.link ? (
      <MobileLinkActionSheet
        url={shown.link}
        onClose={close}
        openInOrca={onOpenUrlInOrca}
        showToast={showToast}
      />
    ) : null
  }, [shown, setShown, onOpenUrlInOrca, showToast])
  return (
    <MobileNativeChatRowOverlaysContext.Provider value={overlays}>
      <MarkdownLinkHandlerContext.Provider value={openLink}>
        {children}
      </MarkdownLinkHandlerContext.Provider>
      {opened}
    </MobileNativeChatRowOverlaysContext.Provider>
  )
}
