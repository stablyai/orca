import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentSessionRewindSurface } from '../../../../../../src/shared/agent-session/lifecycle/rewind/agent-session-rewind-request'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { triggerMediumImpact } from '../../../../platform/haptics/haptics'
import { MobileImageViewer } from '../../../../files/media/presentation/MobileImageViewer'
import { MobileImageViewerActions } from '../../visual/MobileImageViewerActions'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'
import { MobileLinkActionSheet } from '../../../../browser/link-open/MobileLinkActionSheet'
import { openMobileWebLink } from '../../../../browser/link-open/mobile-web-link-open'
import type { MobileLinkOpenMode } from '../../../../storage/preferences'
import { MarkdownLinkHandlerContext } from '../../../../components/markdown/links/markdown-link-handler'
import {
  MobileNativeChatRowOverlaysContext,
  type MobileNativeChatViewedImage
} from './mobile-native-chat-row-overlays'
import {
  useMobileNativeChatConversationState,
  type MobileNativeChatConversation
} from '../../conversation/use-mobile-native-chat-conversation-state'
import type { MobileNativeChatImageSource } from '../../visual/mobile-native-chat-image-preview'
import { MobileNativeChatRewindContext } from './mobile-native-chat-rewind-context'
import { useMobileNativeChatRewindDialog } from './use-mobile-native-chat-rewind-dialog'
import { MobileNativeChatRewindDialog } from './MobileNativeChatRewindDialog'

export function MobileNativeChatRowOverlaysHost({
  conversation,
  imageSource,
  onOpenUrlInOrca,
  linkOpenMode,
  rewind,
  openSubagent,
  children
}: {
  conversation: MobileNativeChatConversation
  imageSource?: MobileNativeChatImageSource
  /** Absent where the host can't open a browser tab for this chat. */
  onOpenUrlInOrca?: (url: string) => void
  linkOpenMode: MobileLinkOpenMode
  /** The chat's "Rewind to here"; absent where it can't rewind. */
  rewind?: AgentSessionRewindSurface
  openSubagent?: (agentId: string) => void
  children?: React.ReactNode
}): React.JSX.Element {
  const { openRewind, dialog, close: closeRewind } = useMobileNativeChatRewindDialog(rewind)
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
      openRewind,
      imageSource,
      ...(openSubagent ? { openSubagent } : {})
    }),
    [setShown, openRewind, imageSource, openSubagent]
  )
  // Why a ref: every markdown block reads openLink, so a reconnect must not change its identity.
  const linkRouteRef = useRef({ linkOpenMode, onOpenUrlInOrca })
  useLayoutEffect(() => {
    linkRouteRef.current = { linkOpenMode, onOpenUrlInOrca }
  }, [linkOpenMode, onOpenUrlInOrca])
  const openLink = useCallback(
    (url: string) => {
      const route = linkRouteRef.current
      openMobileWebLink(url, route.linkOpenMode, route.onOpenUrlInOrca, (link) =>
        setShown({ link })
      )
    },
    [setShown]
  )
  // Memoize overlay callbacks so streamed words cannot rebuild them.
  const opened = useMemo(() => {
    const close = () => setShown(null)
    return shown?.image ? (
      <MobileImageViewer {...shown.image} actions={MobileImageViewerActions} onClose={close} />
    ) : shown?.actionsFor ? (
      <MobileNativeChatMessageActionsSheet message={shown.actionsFor} onClose={close} />
    ) : shown?.link ? (
      <MobileLinkActionSheet url={shown.link} onClose={close} openInOrca={onOpenUrlInOrca} />
    ) : null
  }, [shown, setShown, onOpenUrlInOrca])
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
