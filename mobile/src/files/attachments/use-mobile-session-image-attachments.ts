import { useMemo } from 'react'
import { MOBILE_TERMINAL_FILE_UPLOAD_RUNTIME_CAPABILITY } from '../../../../src/shared/mobile-runtime-capabilities'
import { useRouteCapability } from '../../worktree/use-workspace-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { MobileImageSource } from '../../platform/media-picker-contract'
import type {
  MobileNativeChatSendIntent,
  MobileNativeChatSendOutcome
} from '../../session/native-chat/composer/mobile-native-chat-send'
import type { StructuredMobileSendAttachment } from '../../session/native-chat/composer/use-mobile-structured-send-with-outcome'
import { useMobileImageAttachment } from './use-mobile-image-attachment'
import {
  useMobileNativeChatImageAttachments,
  type MobileNativeChatImageAttachments
} from '../../session/native-chat/composer/use-mobile-native-chat-image-attachments'
import {
  useMobileNativeChatFileAttachments,
  type MobileNativeChatFileAttachments,
  type MobileNativeChatFileTarget
} from '../../session/native-chat/composer/use-mobile-native-chat-file-attachments'

type CurrentRef<T> = { readonly current: T }

type Args = {
  readonly agent?: string | null
  readonly client: RpcClient | null
  readonly activeHandle: string | null
  readonly activeHandleRef: CurrentRef<string | null>
  readonly canSend: boolean
  readonly connState: ConnectionState
  readonly deviceTokenRef: CurrentRef<string | null>
  readonly nativeChatScopeKey: string | null
  readonly nativeChatInputLeaseReady: boolean
  /** False when only memory names the agent: the pane may be a bare shell, so images never send. */
  readonly nativeChatAgentConfirmed: boolean
  readonly getActiveWorktreeConnectionId: () => Promise<string | null>
  readonly beforeTerminalSend: (terminal: string) => Promise<boolean>
  // Preserve unknown delivery for stale-input healing and share the image action’s deadline with its text send.
  readonly nativeChatBaseSend: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[],
    sentAt?: number,
    intent?: MobileNativeChatSendIntent
  ) => Promise<MobileNativeChatSendOutcome>
  readonly structuredNativeChat: boolean
  readonly nativeChatSessionId: string | null
  // Size the leading clear from parked launch context so earlier multiline draft text cannot join images.
  readonly readSeededLaunchDraft: () => string | null
  readonly showToast: (message: string, durationMs?: number) => void
  readonly onNativeChatSendError: (message: string) => void
  readonly onSuccess: () => void
  readonly onError: () => void
}

// Share upload wiring across immediate terminal paste, deferred chat chips and host-owned structured files.
export function useMobileSessionImageAttachments({
  client,
  agent,
  activeHandle,
  activeHandleRef,
  canSend,
  connState,
  deviceTokenRef,
  nativeChatScopeKey,
  nativeChatInputLeaseReady,
  nativeChatAgentConfirmed,
  getActiveWorktreeConnectionId,
  beforeTerminalSend,
  nativeChatBaseSend,
  structuredNativeChat,
  nativeChatSessionId,
  readSeededLaunchDraft,
  showToast,
  onNativeChatSendError,
  onSuccess,
  onError
}: Args): {
  attachImage: (source: MobileImageSource) => Promise<void>
  isAttaching: boolean
  nativeChatImages: MobileNativeChatImageAttachments
  nativeChatFiles: MobileNativeChatFileAttachments
} {
  const { attachImage, isAttaching } = useMobileImageAttachment({
    client,
    agent,
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
  const terminalFileUploadSupported = useRouteCapability(
    MOBILE_TERMINAL_FILE_UPLOAD_RUNTIME_CAPABILITY
  )
  const fileTarget = useMemo<MobileNativeChatFileTarget | null>(() => {
    if (structuredNativeChat) {
      return nativeChatSessionId ? { kind: 'structured', sessionId: nativeChatSessionId } : null
    }
    return terminalFileUploadSupported
      ? { kind: 'terminal', getConnectionId: getActiveWorktreeConnectionId }
      : null
  }, [
    getActiveWorktreeConnectionId,
    nativeChatSessionId,
    structuredNativeChat,
    terminalFileUploadSupported
  ])
  const nativeChatFiles = useMobileNativeChatFileAttachments({
    client,
    target: fileTarget,
    scopeKey: nativeChatScopeKey,
    enabled: structuredNativeChat
      ? connState === 'connected'
      : nativeChatInputLeaseReady && nativeChatAgentConfirmed && connState === 'connected',
    showToast
  })
  const nativeChatImages = useMobileNativeChatImageAttachments({
    client,
    agent,
    activeHandleRef,
    deviceTokenRef,
    getActiveWorktreeConnectionId,
    connState,
    scopeKey: nativeChatScopeKey,
    enabled: structuredNativeChat
      ? connState === 'connected'
      : nativeChatInputLeaseReady && nativeChatAgentConfirmed,
    structuredNativeChat,
    files: nativeChatFiles.files,
    onFilesSent: nativeChatFiles.removeFiles,
    showToast,
    onSendError: onNativeChatSendError,
    baseSend: nativeChatBaseSend,
    readSeededLaunchDraft,
    onAttachSuccess: onSuccess,
    onError
  })
  return { attachImage, isAttaching, nativeChatImages, nativeChatFiles }
}
