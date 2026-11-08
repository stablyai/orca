import { useCallback, useEffect, useMemo } from 'react'
import type { AgentSessionRewindSurface } from '../../../../../src/shared/agent-session/lifecycle/agent-session-rewind-request'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { triggerMediumImpact } from '../../../platform/haptics'
import { MobileNativeChatImageViewer } from '../visual/MobileNativeChatImageViewer'
import { MobileImageViewerActions } from '../visual/MobileImageViewerActions'
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
import { MobileNativeChatRewindContext } from './mobile-native-chat-rewind-context'
import { useMobileNativeChatRewindDialog } from './use-mobile-native-chat-rewind-dialog'
import { MobileNativeChatRewindDialog } from './MobileNativeChatRewindDialog'

export function MobileNativeChatRowOverlaysHost({
  conversation,
  imageSource,
  onOpenUrlInOrca,
  rewind,
  children
}: {
  conversation: MobileNativeChatConversation
  imageSource?: MobileNativeChatImageSource
  /** Absent where the host can't open a browser tab for this chat. */
  onOpenUrlInOrca?: (url: string) => void
  /** The chat's "Rewind to here"; absent where it can't rewind. */
  rewind?: AgentSessionRewindSurface
  children?: React.ReactNode
}): React.JSX.Element {
  const { openRewind, dialog, close: closeRewind } = useMobileNativeChatRewindDialog(rewind)
  // Keep pressed message text with its conversation so streaming cannot rewrite an open sheet.
  const [shown, setShown] = useMobileNativeChatConversationState<{
    image?: MobileNativeChatViewedImage
    imageOwner?: MobileNativeChatImageSource
    actionsFor?: NativeChatMessage
    link?: string
  }>(conversation)
  const client = imageSource?.client
  const worktreeId = imageSource?.worktreeId
  const ownsImage =
    !shown?.imageOwner ||
    (shown.imageOwner.client === client && shown.imageOwner.worktreeId === worktreeId)
  useEffect(() => {
    if (!ownsImage) {
      setShown(null)
    }
  }, [ownsImage, setShown])
  const overlays = useMemo(
    () => ({
      imageSource,
      openImage: (image: MobileNativeChatViewedImage) =>
        setShown({
          image,
          ...(imageSource ? { imageOwner: imageSource } : {})
        }),
      openActions: (actionsFor: NativeChatMessage) => {
        triggerMediumImpact()
        setShown({ actionsFor })
      },
      openRewind
    }),
    [setShown, openRewind, imageSource]
  )
  const openLink = useCallback((link: string) => setShown({ link }), [setShown])
  // Memoize overlay callbacks so streamed words cannot rebuild them.
  const opened = useMemo(() => {
    const close = () => setShown(null)
    return shown?.image && ownsImage ? (
      <MobileNativeChatImageViewer
        {...shown.image}
        actions={MobileImageViewerActions}
        onClose={close}
      />
    ) : shown?.actionsFor ? (
      <MobileNativeChatMessageActionsSheet message={shown.actionsFor} onClose={close} />
    ) : shown?.link ? (
      <MobileLinkActionSheet url={shown.link} onClose={close} openInOrca={onOpenUrlInOrca} />
    ) : null
  }, [shown, ownsImage, setShown, onOpenUrlInOrca])
  return (
    <MobileNativeChatRowOverlaysContext.Provider value={overlays}>
      <MarkdownLinkHandlerContext.Provider value={openLink}>
        <MobileNativeChatRewindContext.Provider value={rewind}>
          {children}
        </MobileNativeChatRewindContext.Provider>
      </MarkdownLinkHandlerContext.Provider>
      {opened}
      {dialog ? <MobileNativeChatRewindDialog dialog={dialog} onClose={closeRewind} /> : null}
    </MobileNativeChatRowOverlaysContext.Provider>
  )
}
