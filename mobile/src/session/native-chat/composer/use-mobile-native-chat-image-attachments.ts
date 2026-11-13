import {
  addMobileNativeChatDraftImages,
  readMobileNativeChatDraftInputs,
  removeMobileNativeChatDraftImages,
  returnMobileNativeChatDraftAttachments,
  useMobileNativeChatDraftInputs,
  mobileNativeChatDraftDestination,
  type MobileNativeChatDraftDestination
} from './mobile-native-chat-draft-inputs'
import { useCallback, useMemo } from 'react'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import type { MobileImageSource } from '../../../platform/media-picker-contract'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobilePastedImages } from './mobile-native-chat-composer-paste'
import {
  MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS,
  pasteMobileNativeChatImagePaths
} from './mobile-native-chat-image-send'
import {
  openMobileNativeChatSendBudget,
  type MobileNativeChatSendIntent,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import {
  clearMobileNativeChatInputStale,
  markMobileNativeChatInputStale
} from './mobile-native-chat-stale-input'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from './mobile-native-chat-terminal-write-lock'
import { healMobileNativeChatStaleSend } from './mobile-native-chat-stale-send-heal'
import { useMobileNativeChatImageUpload } from './use-mobile-native-chat-image-upload'
import {
  nativeChatSendFiles,
  type PendingNativeChatFile
} from './mobile-native-chat-file-attachment'
import type { StructuredMobileSendAttachment } from './use-mobile-structured-send-with-outcome'

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
    sentAt?: number,
    intent?: MobileNativeChatSendIntent
  ) => Promise<MobileNativeChatSendOutcome>
  /** Structured sessions send attachments without the terminal paste path. */
  readonly structuredNativeChat: boolean
  /** A structured chat's stored files ride the next send beside its images. */
  readonly files?: readonly PendingNativeChatFile[]
  /** Drops the files a send carried once the host took it. */
  readonly onFilesSent?: (ids: readonly string[], owner: MobileNativeChatDraftDestination) => void
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
  readonly attachImage: (source: MobileImageSource | MobilePastedImages) => Promise<void>
  readonly removeAttachment: (id: string) => void
  /** Ride any pending images along with `text`, then submit; clears the sent
   *  chips (and only those) once the send is accepted. */
  readonly sendNativeChat: (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>
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
  const images = useMobileNativeChatDraftInputs(scopeKey, 'images')
  const pending = useMobileNativeChatDraftInputs(scopeKey, 'pending')
  const attachments = useMemo(() => [...images], [images])

  const { attachImage, isAttaching } = useMobileNativeChatImageUpload({
    client,
    activeHandleRef,
    getActiveWorktreeConnectionId,
    connState,
    scopeKey,
    structuredNativeChat,
    showToast,
    onImagesUploaded: addMobileNativeChatDraftImages,
    onAttachSuccess,
    onError
  })

  const removeAttachment = useCallback(
    (id: string): void => {
      const scope = scopeKey
      if (!scope) {
        return
      }
      removeMobileNativeChatDraftImages(scope, [id])
    },
    [scopeKey]
  )

  const sendNativeChat = useCallback(
    async (text: string, intent?: MobileNativeChatSendIntent): Promise<boolean> => {
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
        // A queued message carries its own chips; the composer's are a later draft.
        const queued = intent?.queued
        if (!queued && (readMobileNativeChatDraftInputs(scope).pending ?? 0) > 0) {
          return false
        }
        const pendingImages = queued ? queued.images : attachments
        const sentImageIds = pendingImages.map((attachment) => attachment.id)
        // Hold Send until all selected files finish uploading.
        const sendFiles = nativeChatSendFiles(queued?.files ?? files, text, structuredNativeChat)
        if (!sendFiles) {
          return false
        }
        const { sentFiles, text: terminalText } = sendFiles
        const storedFiles = sentFiles.map(({ id, path }) => ({ kind: 'file' as const, id, path }))
        const sentFileIds = sentFiles.map((file) => file.id)
        const hasAttachments = scope !== null && pendingImages.length + storedFiles.length > 0
        const destination =
          scope && hasAttachments && !queued ? mobileNativeChatDraftDestination(scope) : null
        // An unconfirmed send's text returns to the composer later; bring back the chips it carried too.
        const sendIntent = destination
          ? {
              ...intent,
              carried: { images: pendingImages, files: sentFiles },
              onHandBack: () =>
                returnMobileNativeChatDraftAttachments(destination, pendingImages, sentFiles)
            }
          : intent
        // The @path references are wire-only: the draft, its restore and its in-flight save keep the typed text.
        const wireIntent =
          terminalText === text ? sendIntent : { ...sendIntent, wireText: terminalText }
        if (structuredNativeChat && hasAttachments) {
          if (!client || !enabled || connState !== 'connected') {
            onError?.()
            onSendError('Message not sent (disconnected)')
            return false
          }
          const previews = pendingImages.map((attachment) => attachment.previewUri)
          const sendAttachments = [...pendingImages, ...storedFiles]
          const outcome = await baseSend(
            text,
            previews,
            deadline,
            sendAttachments,
            undefined,
            sendIntent
          )
          if (outcome !== 'rejected' && destination?.active) {
            removeMobileNativeChatDraftImages(destination, sentImageIds)
            onFilesSent?.(sentFileIds, destination)
          }
          return outcome !== 'rejected'
        }
        if (pendingImages.length === 0 || !hasAttachments) {
          // Heal stale paste before text-only sends; on failure retain the marker and submit no text.
          const healError = await healMobileNativeChatStaleSend({
            client,
            enabled,
            connState,
            activeHandleRef,
            deviceToken: deviceTokenRef.current,
            deadline
          })
          if (healError) {
            onError?.()
            onSendError(healError)
            return false
          }
          const outcome = await (wireIntent
            ? baseSend(text, undefined, deadline, undefined, sentAt, wireIntent)
            : baseSend(text, undefined, deadline, undefined, sentAt))
          if (outcome !== 'rejected' && destination?.active) {
            onFilesSent?.(sentFileIds, destination)
          }
          return outcome !== 'rejected'
        }
        const handle = activeHandleRef.current
        if (!client || !handle || !enabled || connState !== 'connected') {
          onError?.()
          onSendError('Message not sent (disconnected)')
          return false
        }
        let inputWriteStarted = false
        try {
          const seededLaunchDraft = readSeededLaunchDraft()
          const pasted = await pasteMobileNativeChatImagePaths({
            client,
            terminal: handle,
            agent,
            deviceToken: deviceTokenRef.current,
            imagePaths: pendingImages.map((attachment) => attachment.path),
            followedByText: terminalText.trim().length > 0,
            deadline,
            onWriteStarted: () => {
              inputWriteStarted = true
            },
            ...(seededLaunchDraft ? { seededText: seededLaunchDraft } : {})
          })
          if (!pasted) {
            if (inputWriteStarted) {
              markMobileNativeChatInputStale(handle)
            }
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
            sentAt,
            wireIntent
          )
          if (outcome !== 'accepted') {
            // Rejected or unknown text/Enter may orphan an already-pasted path; both outcomes require healing.
            markMobileNativeChatInputStale(handle)
          }
          if (outcome !== 'rejected' && destination?.active) {
            // Drop only chips in this send, including unknown delivery to avoid duplicate retries; preserve newly attached chips.
            removeMobileNativeChatDraftImages(destination, sentImageIds)
            onFilesSent?.(sentFileIds, destination)
          }
          return outcome !== 'rejected'
        } catch {
          // Only attempted writes can leave partial input for the next action to heal.
          if (inputWriteStarted) {
            markMobileNativeChatInputStale(handle)
          }
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
    isAttaching: isAttaching || (pending ?? 0) > 0,
    attachImage,
    removeAttachment,
    sendNativeChat
  }
}
