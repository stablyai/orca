import { createUuidV4 } from '../../../../../src/shared/uuid-v4'
import {
  readMobileNativeChatDraftInputs,
  useMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs,
  type MobileNativeChatDraftDestination
} from './mobile-native-chat-draft-inputs'
import { useCallback, useMemo } from 'react'
import { buildAgentTuiClearInputForText } from '../../../../../src/shared/agent-tui-input-clear'
import type { RpcClient } from '../../../transport/rpc-client'
import type { ConnectionState } from '../../../transport/types'
import type { MobileImageSource } from '../../../platform/media-picker-contract'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import {
  MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS,
  pasteMobileNativeChatImagePaths
} from './mobile-native-chat-image-send'
import {
  openMobileNativeChatSendBudget,
  type MobileNativeChatSendOutcome
} from '../mobile-native-chat-send'
import {
  clearMobileNativeChatInputStale,
  healMobileNativeChatStaleInput,
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale
} from '../mobile-native-chat-stale-input'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from '../mobile-native-chat-terminal-write-lock'
import { useMobileNativeChatImageUpload } from './use-mobile-native-chat-image-upload'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'
import type { StructuredMobileSendAttachment } from '../../use-mobile-structured-send-with-outcome'

type CurrentRef<T> = { readonly current: T }
type ShowToast = (message: string, durationMs?: number) => void

type Args = {
  readonly agent?: string | null
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
  readonly showToast: ShowToast
  /** Send failures go to the composer's inline banner, not the toast — the same
   *  channel the controller's own rejections use, so one failure paints once. */
  readonly onSendError: (message: string) => void
  /** The plain text send (controller.handleNativeChatSendWithOutcome); wrapped so
   *  images ride along. The optional URIs drive the optimistic echo's thumbnails.
   *  Must preserve 'unknown': after a successful paste, an ambiguously-delivered
   *  text+Enter may have left the image on the input line, which needs healing.
   *  Accepts this action's budget so the text body draws from what the paste left
   *  rather than opening a second one, and its press time, which the echo shows. */
  readonly baseSend: (
    text: string,
    imagePreviewUris?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[],
    sentAt?: number
  ) => Promise<MobileNativeChatSendOutcome>
  /** Structured sessions send attachments without the terminal paste path. */
  readonly structuredNativeChat: boolean
  /** A structured chat's stored files ride the next send beside its images. */
  readonly files?: readonly PendingNativeChatFile[]
  /** Drops the files a send carried once the host took it. */
  readonly onFilesSent?: (ids: readonly string[]) => void
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

const NO_FILES: readonly PendingNativeChatFile[] = []

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function useMobileNativeChatImageAttachments({
  client,
  agent,
  activeHandleRef,
  deviceTokenRef,
  getActiveWorktreeConnectionId,
  connState,
  scopeKey,
  enabled,
  showToast,
  onSendError,
  baseSend,
  structuredNativeChat,
  files = NO_FILES,
  onFilesSent,
  readSeededLaunchDraft,
  onAttachSuccess,
  onError,
  sleep = defaultSleep
}: Args): MobileNativeChatImageAttachments {
  const inputs = useMobileNativeChatDraftInputs(scopeKey)
  const images = inputs.images
  const attachments = useMemo(() => [...images], [images])

  const addUploadedImages = useCallback(
    (
      scope: MobileNativeChatDraftDestination,
      uploadedImages: Omit<PendingNativeChatImage, 'id'>[]
    ) => {
      updateMobileNativeChatDraftInputs(scope, (current) => ({
        ...current,
        images: [
          ...current.images,
          ...uploadedImages.map((image) => ({ ...image, id: createUuidV4() }))
        ]
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
    showToast,
    onImagesUploaded: addUploadedImages,
    onAttachSuccess,
    onError
  })

  const removeAttachment = useCallback(
    (id: string): void => {
      const scope = scopeKey
      if (!scope) {
        return
      }
      updateMobileNativeChatDraftInputs(scope, (current) => ({
        ...current,
        images: current.images.filter((attachment) => attachment.id !== id)
      }))
    },
    [scopeKey]
  )

  const sendNativeChat = useCallback(
    async (text: string): Promise<boolean> => {
      // Serialize clear/paste/submit ownership per terminal while allowing other
      // tabs to send. Shared with the prompt-card writes (answer/permission), so
      // a card tap can't interleave into a mid-flight paste sequence either.
      const operationTerminal = activeHandleRef.current
      if (operationTerminal && !acquireMobileNativeChatTerminalWrite(operationTerminal)) {
        onError?.()
        onSendError('Message not sent')
        return false
      }
      // Use one action budget across paste, settle and text so per-leg clocks cannot double the composer lock.
      const deadline = openMobileNativeChatSendBudget()
      const sentAt = Date.now()
      try {
        const scope = scopeKey
        if ((readMobileNativeChatDraftInputs(scope).pending ?? 0) > 0) {
          return false
        }
        const pendingImages = attachments
        // Hold Send until all selected files finish uploading.
        const storedFiles = structuredNativeChat
          ? files.flatMap((file) =>
              file.path === null ? [] : [{ kind: 'file' as const, id: file.id, path: file.path }]
            )
          : []
        if (structuredNativeChat && pendingImages.length + storedFiles.length > 0 && scope) {
          if (!client || !enabled || connState !== 'connected') {
            onError?.()
            onSendError('Message not sent (disconnected)')
            return false
          }
          const outcome = await baseSend(
            text,
            pendingImages.map((attachment) => attachment.previewUri),
            deadline,
            [...pendingImages, ...storedFiles]
          )
          if (outcome !== 'rejected') {
            const sentIds = new Set(pendingImages.map((attachment) => attachment.id))
            updateMobileNativeChatDraftInputs(scope, (current) => ({
              ...current,
              images: current.images.filter((attachment) => !sentIds.has(attachment.id))
            }))
            onFilesSent?.(storedFiles.map((file) => file.id))
          }
          return outcome !== 'rejected'
        }
        if (pendingImages.length === 0 || !scope) {
          // Heal stale paste before text-only sends; on failure retain the marker and submit no text.
          const staleTerminal = activeHandleRef.current
          if (staleTerminal && isMobileNativeChatInputStale(staleTerminal)) {
            // Healing writes also need the input lease; retry once ready instead of latching every subsequent send as failed.
            if (!client || !enabled || connState !== 'connected') {
              onError?.()
              onSendError('Message not sent (disconnected)')
              return false
            }
            const healed = await healMobileNativeChatStaleInput({
              client,
              terminal: staleTerminal,
              deviceToken: deviceTokenRef.current,
              deadline
            })
            // Abort after a tab switch during clear rather than sending text to a different terminal.
            if (!healed || activeHandleRef.current !== staleTerminal) {
              onError?.()
              onSendError('Message not sent')
              return false
            }
          }
          return (await baseSend(text, undefined, deadline, undefined, sentAt)) !== 'rejected'
        }
        const handle = activeHandleRef.current
        if (!client || !handle || !enabled || connState !== 'connected') {
          onError?.()
          onSendError('Message not sent (disconnected)')
          return false
        }
        try {
          const seededLaunchDraft = readSeededLaunchDraft()
          const pasted = await pasteMobileNativeChatImagePaths({
            client,
            terminal: handle,
            agent,
            deviceToken: deviceTokenRef.current,
            imagePaths: pendingImages.map((attachment) => attachment.path),
            followedByText: text.trim().length > 0,
            deadline,
            ...(seededLaunchDraft
              ? { clearInput: buildAgentTuiClearInputForText(seededLaunchDraft) }
              : {})
          })
          if (!pasted) {
            markMobileNativeChatInputStale(handle)
            onError?.()
            onSendError('Message not sent')
            return false
          }
          clearMobileNativeChatInputStale(handle)
          // Let the TUI absorb image paste before text/Enter; pass local previews to the optimistic echo.
          await sleep(MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS)
          // Credit deliberate TUI settle back to the transport budget.
          const textDeadline = deadline + MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS
          // Abort if the target changed during settle; retain scoped chips and let retry clear the stale paste.
          if (activeHandleRef.current !== handle) {
            markMobileNativeChatInputStale(handle)
            onError?.()
            onSendError('Message not sent')
            return false
          }
          const outcome = await baseSend(
            text,
            pendingImages.map((attachment) => attachment.previewUri),
            textDeadline,
            undefined,
            sentAt
          )
          if (outcome !== 'accepted') {
            // Rejected or unknown text/Enter may orphan an already-pasted path; both outcomes require healing.
            markMobileNativeChatInputStale(handle)
          }
          if (outcome !== 'rejected') {
            // Drop only chips in this send, including unknown delivery to avoid duplicate retries; preserve newly attached chips.
            const sentIds = new Set(pendingImages.map((attachment) => attachment.id))
            updateMobileNativeChatDraftInputs(scope, (current) => ({
              ...current,
              images: current.images.filter((attachment) => !sentIds.has(attachment.id))
            }))
          }
          return outcome !== 'rejected'
        } catch {
          // Contain transport rejection and keep chips; the next attempt’s leading clear removes any partial paste.
          markMobileNativeChatInputStale(handle)
          onError?.()
          onSendError('Message not sent')
          return false
        }
      } finally {
        if (operationTerminal) {
          releaseMobileNativeChatTerminalWrite(operationTerminal)
        }
      }
    },
    [
      activeHandleRef,
      attachments,
      baseSend,
      client,
      connState,
      agent,
      deviceTokenRef,
      enabled,
      files,
      onError,
      onFilesSent,
      onSendError,
      readSeededLaunchDraft,
      scopeKey,
      sleep
    ]
  )

  return {
    attachments,
    isAttaching: isAttaching || (inputs.pending ?? 0) > 0,
    attachImage,
    removeAttachment,
    sendNativeChat
  }
}
