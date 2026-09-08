import { useCallback, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'
import type { MobileImageSource } from './mobile-image-source-picker'
import {
  appendPendingNativeChatImages,
  type PendingNativeChatImage
} from './mobile-native-chat-image-attachment'
import {
  NO_NATIVE_CHAT_IMAGE_ATTACHMENTS,
  withScopeAttachments,
  type MobileNativeChatImagesByScope
} from './mobile-native-chat-image-scope-state'
import {
  sendMobileNativeChatWithImages,
  type MobileNativeChatImageBaseSend
} from './mobile-native-chat-image-submit'
import { openMobileNativeChatSendBudget } from './mobile-native-chat-send'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from './mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatImageUpload } from './use-mobile-native-chat-image-upload'

type CurrentRef<T> = { readonly current: T }
type ShowToast = (message: string, durationMs?: number) => void

type Args = {
  readonly client: RpcClient | null
  readonly activeHandleRef: CurrentRef<string | null>
  readonly deviceTokenRef: CurrentRef<string | null>
  readonly getActiveWorktreeConnectionId: () => Promise<string | null>
  readonly connState: ConnectionState
  /** Identity of the active composer surface (same key shape as the drafts hook):
   *  chips are scoped to the tab that picked them, so a tab switch cannot ride
   *  one tab's image into another tab's terminal. Null disables attaching. */
  readonly scopeKey: string | null
  /** The native-chat input lease is ready — same gate `handleNativeChatSend` uses. */
  readonly enabled: boolean
  readonly operations: HostSessionNativeChatOperations | null
  readonly targetRef: CurrentRef<HostSessionNativeChatTarget | null>
  readonly showToast: ShowToast
  /** Send failures go to the composer's inline banner, not the toast — the same
   *  channel the controller's own rejections use, so one failure paints once. */
  readonly onSendError: (message: string) => void
  /** The plain text send (controller.handleNativeChatSendWithOutcome); wrapped so
   *  images ride along. The optional URIs drive the optimistic echo's thumbnails.
   *  Must preserve 'unknown': after a successful paste, an ambiguously-delivered
   *  text+Enter may have left the image on the input line, which needs healing.
   *  Accepts this action's budget so the text body draws from what the paste left
   *  rather than opening a second one. */
  readonly baseSend: MobileNativeChatImageBaseSend
  /** Structured sessions send attachments without the terminal paste path. */
  readonly structuredNativeChat: boolean
  /** Launch-context text parked on the agent's TUI input line, or null. The
   *  paste's leading clear must cover every line of it, or the draft's earlier
   *  lines survive and ride along with the image. */
  readonly readSeededLaunchDraft: () => string | null
  readonly onAttachSuccess?: () => void
  readonly onError?: () => void
  // Injected so the settle between image paste and submit is instant in tests.
  readonly sleep?: (ms: number) => Promise<void>
}

export type MobileNativeChatImageAttachments = {
  /** Pending chips for the active scope (tab) only. */
  readonly attachments: PendingNativeChatImage[]
  readonly isAttaching: boolean
  readonly attachImage: (source: MobileImageSource) => Promise<void>
  readonly removeAttachment: (id: string) => void
  /** Ride any pending images along with `text`, then submit; clears the sent
   *  chips (and only those) once the send is accepted. */
  readonly sendNativeChat: (text: string) => Promise<boolean>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function useMobileNativeChatImageAttachments({
  client,
  activeHandleRef,
  deviceTokenRef,
  getActiveWorktreeConnectionId,
  connState,
  scopeKey,
  enabled,
  operations,
  targetRef,
  showToast,
  onSendError,
  baseSend,
  structuredNativeChat,
  readSeededLaunchDraft,
  onAttachSuccess,
  onError,
  sleep = defaultSleep
}: Args): MobileNativeChatImageAttachments {
  const [attachmentsByScope, setAttachmentsByScope] = useState<MobileNativeChatImagesByScope>({})
  const idCounter = useRef(0)
  const attachments =
    (scopeKey ? attachmentsByScope[scopeKey] : undefined) ?? NO_NATIVE_CHAT_IMAGE_ATTACHMENTS

  const addUploadedImages = useCallback(
    (scope: string, uploadedImages: Omit<PendingNativeChatImage, 'id'>[]) => {
      setAttachmentsByScope((prev) => ({
        ...prev,
        [scope]: appendPendingNativeChatImages(prev[scope] ?? [], uploadedImages, idCounter)
      }))
    },
    []
  )

  const { attachImage, isAttaching } = useMobileNativeChatImageUpload({
    client,
    activeHandleRef,
    getActiveWorktreeConnectionId,
    connState,
    scopeKey,
    structuredNativeChat,
    operations,
    targetRef,
    showToast,
    onImagesUploaded: addUploadedImages,
    onAttachSuccess,
    onError
  })

  const dropSentAttachments = useCallback((scope: string, sentIds: ReadonlySet<string>) => {
    setAttachmentsByScope((prev) =>
      withScopeAttachments(
        prev,
        scope,
        (prev[scope] ?? []).filter((attachment) => !sentIds.has(attachment.id))
      )
    )
  }, [])

  const removeAttachment = useCallback(
    (id: string): void => {
      const scope = scopeKey
      if (!scope) {
        return
      }
      const removed = attachmentsByScope[scope]?.find((attachment) => attachment.id === id)
      const target = targetRef.current
      setAttachmentsByScope((prev) =>
        withScopeAttachments(
          prev,
          scope,
          (prev[scope] ?? []).filter((attachment) => attachment.id !== id)
        )
      )
      if (!client && removed && target) {
        void operations?.releaseImages?.(target, [removed.path]).catch(() => {})
      }
    },
    [attachmentsByScope, client, operations, scopeKey, targetRef]
  )

  const sendNativeChat = useCallback(
    async (text: string): Promise<boolean> => {
      const scope = scopeKey
      const pendingImages =
        (scope ? attachmentsByScope[scope] : undefined) ?? NO_NATIVE_CHAT_IMAGE_ATTACHMENTS
      // Serialize clear/paste/submit ownership per terminal while allowing other
      // tabs to send. Shared with the prompt-card writes (answer/permission), so
      // a card tap can't interleave into a mid-flight paste sequence either. The
      // structured path writes to the same PTY, so it takes the lock too.
      const operationTerminal = activeHandleRef.current
      if (operationTerminal && !acquireMobileNativeChatTerminalWrite(operationTerminal)) {
        onError?.()
        onSendError('Message not sent')
        return false
      }
      // Why: one budget per action, shared by whichever leg runs.
      const deadline = openMobileNativeChatSendBudget()
      try {
        if (structuredNativeChat && pendingImages.length > 0 && scope) {
          if (!client || !enabled || connState !== 'connected') {
            onError?.()
            onSendError('Message not sent (disconnected)')
            return false
          }
          const outcome = await baseSend(
            text,
            pendingImages.map((attachment) => attachment.previewUri),
            deadline,
            pendingImages
          )
          if (outcome !== 'rejected') {
            dropSentAttachments(scope, new Set(pendingImages.map((attachment) => attachment.id)))
          }
          return outcome !== 'rejected'
        }
        return await sendMobileNativeChatWithImages({
          text,
          pendingImages,
          client,
          activeHandleRef,
          deviceTokenRef,
          connState,
          enabled,
          operations,
          targetRef,
          baseSend,
          readSeededLaunchDraft,
          onError,
          onSendError,
          sleep,
          onSent(sentIds) {
            if (scope) {
              dropSentAttachments(scope, sentIds)
            }
          }
        })
      } finally {
        if (operationTerminal) {
          releaseMobileNativeChatTerminalWrite(operationTerminal)
        }
      }
    },
    [
      activeHandleRef,
      attachmentsByScope,
      baseSend,
      client,
      connState,
      deviceTokenRef,
      dropSentAttachments,
      enabled,
      onError,
      onSendError,
      operations,
      readSeededLaunchDraft,
      scopeKey,
      sleep,
      structuredNativeChat,
      targetRef
    ]
  )

  return { attachments, isAttaching, attachImage, removeAttachment, sendNativeChat }
}
