import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { MobileImageSource } from './mobile-image-source-picker'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { useMobileImageAttachment } from './use-mobile-image-attachment'
import {
  useMobileNativeChatImageAttachments,
  type MobileNativeChatImageAttachments
} from './use-mobile-native-chat-image-attachments'

type CurrentRef<T> = { readonly current: T }

type Args = {
  readonly client: RpcClient | null
  readonly activeHandle: string | null
  readonly activeHandleRef: CurrentRef<string | null>
  readonly canSend: boolean
  readonly connState: ConnectionState
  readonly deviceTokenRef: CurrentRef<string | null>
  /** Active-tab identity (same key shape as the drafts hook) — native-chat chips
   *  are scoped per tab so a switch can't ride an image into another terminal. */
  readonly nativeChatScopeKey: string | null
  readonly nativeChatInputLeaseReady: boolean
  readonly getActiveWorktreeConnectionId: () => Promise<string | null>
  readonly beforeTerminalSend: (terminal: string) => Promise<boolean>
  /** Outcome-preserving so an ambiguous ('unknown') delivery after an image
   *  paste can mark the terminal input for healing (#10228). */
  readonly nativeChatBaseSend: (
    text: string,
    images?: string[]
  ) => Promise<MobileNativeChatSendOutcome>
  readonly showToast: (message: string, durationMs?: number) => void
  readonly onSuccess: () => void
  readonly onError: () => void
}

/** A session exposes image attachment on two surfaces that share one upload
 *  pipeline and host wiring: the visible terminal input (immediate bracketed
 *  paste) and the native-chat composer (chips deferred to submit). Owning both
 *  here keeps the already-dense session route to a single wiring point. */
export function useMobileSessionImageAttachments({
  client,
  activeHandle,
  activeHandleRef,
  canSend,
  connState,
  deviceTokenRef,
  nativeChatScopeKey,
  nativeChatInputLeaseReady,
  getActiveWorktreeConnectionId,
  beforeTerminalSend,
  nativeChatBaseSend,
  showToast,
  onSuccess,
  onError
}: Args): {
  attachImage: (source: MobileImageSource) => Promise<void>
  isAttaching: boolean
  nativeChatImages: MobileNativeChatImageAttachments
} {
  const { attachImage, isAttaching } = useMobileImageAttachment({
    client,
    activeHandle,
    canSend,
    connState,
    deviceTokenRef,
    beforeTerminalSend,
    getActiveWorktreeConnectionId,
    showToast,
    onSuccess,
    onError
  })
  const nativeChatImages = useMobileNativeChatImageAttachments({
    client,
    activeHandleRef,
    deviceTokenRef,
    getActiveWorktreeConnectionId,
    connState,
    scopeKey: nativeChatScopeKey,
    enabled: nativeChatInputLeaseReady,
    showToast,
    baseSend: nativeChatBaseSend,
    onAttachSuccess: onSuccess,
    onError
  })
  return { attachImage, isAttaching, nativeChatImages }
}
