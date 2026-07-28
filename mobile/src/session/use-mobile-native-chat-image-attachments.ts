import { useCallback, useRef, useState } from 'react'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../src/shared/clipboard-image'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  ImageLibraryPermissionError,
  pickMobileImage,
  type MobileImageSource
} from './mobile-image-source-picker'
import {
  uploadMobileNativeChatImage,
  type PendingNativeChatImage
} from './mobile-native-chat-image-attachment'
import {
  MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS,
  pasteMobileNativeChatImagePaths
} from './mobile-native-chat-image-send'
import {
  openMobileNativeChatSendBudget,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import {
  clearMobileNativeChatInputStale,
  healMobileNativeChatStaleInput,
  isMobileNativeChatInputStale,
  markMobileNativeChatInputStale
} from './mobile-native-chat-stale-input'

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
  readonly baseSend: (
    text: string,
    imagePreviewUris?: string[],
    deadline?: number
  ) => Promise<MobileNativeChatSendOutcome>
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const NO_ATTACHMENTS: PendingNativeChatImage[] = []

function withScopeAttachments(
  byScope: Record<string, PendingNativeChatImage[]>,
  scope: string,
  next: PendingNativeChatImage[]
): Record<string, PendingNativeChatImage[]> {
  if (next.length > 0) {
    return { ...byScope, [scope]: next }
  }
  const remaining = { ...byScope }
  delete remaining[scope]
  return remaining
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
  showToast,
  onSendError,
  baseSend,
  onAttachSuccess,
  onError,
  sleep = defaultSleep
}: Args): MobileNativeChatImageAttachments {
  const [attachmentsByScope, setAttachmentsByScope] = useState<
    Record<string, PendingNativeChatImage[]>
  >({})
  const [isAttaching, setIsAttaching] = useState(false)
  const idCounter = useRef(0)
  // Count in-flight uploads so an overlapping attach can't clear the flag early.
  const attachingCount = useRef(0)
  // Live connState for attachImage's catch: the closure's value was already
  // checked 'connected' at entry, so only a ref can see a mid-upload disconnect.
  const connStateRef = useRef(connState)
  connStateRef.current = connState
  // Serialize clear/paste/submit ownership per terminal while allowing other tabs to send.
  const sendInFlightTerminalsRef = useRef(new Set<string>())

  const attachments = (scopeKey ? attachmentsByScope[scopeKey] : undefined) ?? NO_ATTACHMENTS

  const attachImage = useCallback(
    async (source: MobileImageSource): Promise<void> => {
      // The chip lands in the scope that initiated the pick, even if the user
      // switches tabs while the upload is in flight.
      const scope = scopeKey
      if (!client || !scope || !activeHandleRef.current || connState !== 'connected') {
        return
      }
      // Only this call's own increment may be undone in `finally`; a cancelled
      // pick or pre-upload error never ran `onUploadStart`, so decrementing the
      // shared counter would clear a concurrent upload's in-flight flag early.
      let started = false
      try {
        const uploaded = await uploadMobileNativeChatImage(source, {
          client,
          getConnectionId: getActiveWorktreeConnectionId,
          pickImage: pickMobileImage,
          onUploadStart: () => {
            started = true
            attachingCount.current += 1
            setIsAttaching(true)
          }
        })
        // Cancelled picker: no error, no toast.
        if (!uploaded) {
          return
        }
        idCounter.current += 1
        const chip = { id: `img-${idCounter.current}`, ...uploaded }
        setAttachmentsByScope((prev) => ({ ...prev, [scope]: [...(prev[scope] ?? []), chip] }))
        onAttachSuccess?.()
      } catch (error) {
        onError?.()
        if (connStateRef.current !== 'connected') {
          showToast('Attach failed (disconnected)', 1500)
          return
        }
        if (error instanceof ImageLibraryPermissionError) {
          showToast('Photo permission denied', 1500)
          return
        }
        if (getErrorMessage(error) === CLIPBOARD_IMAGE_TOO_LARGE_ERROR) {
          showToast('Image too large to attach', 1500)
          return
        }
        showToast('Attach failed', 1500)
      } finally {
        if (started) {
          attachingCount.current -= 1
          if (attachingCount.current <= 0) {
            attachingCount.current = 0
            setIsAttaching(false)
          }
        }
      }
    },
    [
      activeHandleRef,
      client,
      connState,
      getActiveWorktreeConnectionId,
      onAttachSuccess,
      onError,
      scopeKey,
      showToast
    ]
  )

  const removeAttachment = useCallback(
    (id: string): void => {
      const scope = scopeKey
      if (!scope) {
        return
      }
      setAttachmentsByScope((prev) =>
        withScopeAttachments(
          prev,
          scope,
          (prev[scope] ?? []).filter((attachment) => attachment.id !== id)
        )
      )
    },
    [scopeKey]
  )

  const sendNativeChat = useCallback(
    async (text: string): Promise<boolean> => {
      const operationTerminal = activeHandleRef.current
      if (operationTerminal && sendInFlightTerminalsRef.current.has(operationTerminal)) {
        onError?.()
        onSendError('Message not sent')
        return false
      }
      if (operationTerminal) {
        sendInFlightTerminalsRef.current.add(operationTerminal)
      }
      // One budget for the whole user action. The paste loop, the settle, and the
      // text body that follows are a single send from the composer's point of view;
      // opening a budget per leg let `sending` run to twice the stated ceiling.
      const deadline = openMobileNativeChatSendBudget()
      try {
        const scope = scopeKey
        const pendingImages = (scope ? attachmentsByScope[scope] : undefined) ?? NO_ATTACHMENTS
        if (pendingImages.length === 0 || !scope) {
          // Heal a previously failed paste: a text-only send to that terminal would
          // otherwise glue the stale image paste onto this message. Best-effort —
          // on failure the marker stays set and the text must not be submitted.
          const staleTerminal = activeHandleRef.current
          if (staleTerminal && isMobileNativeChatInputStale(staleTerminal)) {
            // Why: the heal is itself a terminal.send, so without the input lease it
            // can only be rejected — which used to latch the marker and fail every
            // later send with a bare "Message not sent" (#10681). Gate it like the
            // image path; the heal retries once the lease is back.
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
            // A tab switch during the clear would send this text to a terminal the
            // clear never touched, so abort rather than reroute it.
            if (!healed || activeHandleRef.current !== staleTerminal) {
              onError?.()
              onSendError('Message not sent')
              return false
            }
          }
          // Text-only sends paste nothing first, so 'unknown' leaves no stale input.
          return (await baseSend(text, undefined, deadline)) !== 'rejected'
        }
        const handle = activeHandleRef.current
        if (!client || !handle || !enabled || connState !== 'connected') {
          onError?.()
          // Mirror the text path's failure surface (the base send is never reached).
          onSendError('Message not sent (disconnected)')
          return false
        }
        try {
          const pasted = await pasteMobileNativeChatImagePaths({
            client,
            terminal: handle,
            deviceToken: deviceTokenRef.current,
            imagePaths: pendingImages.map((attachment) => attachment.path),
            deadline
          })
          if (!pasted) {
            // Keep the chips so the user can retry; the failed paste never submitted.
            markMobileNativeChatInputStale(handle)
            onError?.()
            onSendError('Message not sent')
            return false
          }
          // The paste's leading Ctrl+U cleared any earlier stale input in `handle`.
          clearMobileNativeChatInputStale(handle)
          // Let the TUI absorb the image paste before the text + Enter follow. The
          // preview URIs ride along to baseSend so the sent bubble shows the photo
          // immediately (empty text still submits a bare Enter through baseSend).
          await sleep(MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS)
          // The settle is deliberate pacing, not transport latency — credit it back
          // so a shared budget doesn't charge the text body for the TUI's beat.
          const textDeadline = deadline + MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS
          // The paste above targeted `handle`; a tab switch during the settle would
          // route the text + Enter to a different terminal than the images. Abort —
          // the chips keep their scope and a retry's Ctrl+U clears the stale paste.
          if (activeHandleRef.current !== handle) {
            markMobileNativeChatInputStale(handle)
            onError?.()
            onSendError('Message not sent')
            return false
          }
          const outcome = await baseSend(
            text,
            pendingImages.map((attachment) => attachment.previewUri),
            textDeadline
          )
          if (outcome !== 'accepted') {
            // 'rejected' leaves the pasted image path on this input line; 'unknown'
            // may have lost the text+Enter AFTER the paste landed, orphaning the
            // image onto whatever is sent next (#10228) — both must heal first.
            markMobileNativeChatInputStale(handle)
          }
          if (outcome !== 'rejected') {
            // Drop only what rode along — a chip attached while this send was in
            // flight keeps waiting for its own send. 'unknown' clears too: the
            // send usually DID land, and a kept chip would double-send the image.
            const sentIds = new Set(pendingImages.map((attachment) => attachment.id))
            setAttachmentsByScope((prev) =>
              withScopeAttachments(
                prev,
                scope,
                (prev[scope] ?? []).filter((attachment) => !sentIds.has(attachment.id))
              )
            )
          }
          return outcome !== 'rejected'
        } catch {
          // A thrown paste/send (network/RPC) keeps the chips and honors the
          // Promise<boolean> contract instead of rejecting. Retry-safe: the next
          // attempt's leading Ctrl+U clears whatever fraction of the paste landed.
          markMobileNativeChatInputStale(handle)
          onError?.()
          onSendError('Message not sent')
          return false
        }
      } finally {
        if (operationTerminal) {
          sendInFlightTerminalsRef.current.delete(operationTerminal)
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
      enabled,
      onError,
      onSendError,
      scopeKey,
      sleep
    ]
  )

  return { attachments, isAttaching, attachImage, removeAttachment, sendNativeChat }
}
