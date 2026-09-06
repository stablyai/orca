import { buildAgentTuiClearInputForText } from '../../../src/shared/agent-tui-input-clear'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
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

export type MobileNativeChatImageBaseSend = (
  text: string,
  imagePreviewUris?: string[],
  deadline?: number,
  attachments?: readonly PendingNativeChatImage[]
) => Promise<MobileNativeChatSendOutcome>

export async function sendMobileNativeChatWithImages(args: {
  readonly text: string
  readonly pendingImages: readonly PendingNativeChatImage[]
  readonly client: RpcClient | null
  readonly activeHandleRef: CurrentRef<string | null>
  readonly deviceTokenRef: CurrentRef<string | null>
  readonly connState: ConnectionState
  readonly enabled: boolean
  readonly operations: HostSessionNativeChatOperations | null
  readonly targetRef: CurrentRef<HostSessionNativeChatTarget | null>
  readonly baseSend: MobileNativeChatImageBaseSend
  readonly readSeededLaunchDraft: () => string | null
  readonly onSent: (sentIds: ReadonlySet<string>) => void
  readonly onError?: () => void
  readonly onSendError: (message: string) => void
  readonly sleep: (ms: number) => Promise<void>
}): Promise<boolean> {
  const deadline = openMobileNativeChatSendBudget()
  if (args.pendingImages.length === 0) {
    return sendTextAfterStaleInputHeal(args, deadline)
  }
  const handle = args.activeHandleRef.current
  const target = args.targetRef.current
  if (
    !handle ||
    !args.enabled ||
    args.connState !== 'connected' ||
    (!args.client && (!args.operations?.pasteImages || !target))
  ) {
    args.onError?.()
    args.onSendError('Message not sent (disconnected)')
    return false
  }
  try {
    const references = args.pendingImages.map((attachment) => attachment.path)
    const followedByText = args.text.trim().length > 0
    const seededLaunchDraft = args.readSeededLaunchDraft()
    const pasted = args.client
      ? await pasteMobileNativeChatImagePaths({
          client: args.client,
          terminal: handle,
          deviceToken: args.deviceTokenRef.current,
          imagePaths: references,
          followedByText,
          deadline,
          ...(seededLaunchDraft
            ? { clearInput: buildAgentTuiClearInputForText(seededLaunchDraft) }
            : {})
        })
      : await args.operations!.pasteImages!(target!, references, deadline, followedByText)
    if (!pasted) {
      markMobileNativeChatInputStale(handle)
      args.onError?.()
      args.onSendError('Message not sent')
      return false
    }
    clearMobileNativeChatInputStale(handle)
    await args.sleep(MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS)
    const textDeadline = deadline + MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS
    if (args.activeHandleRef.current !== handle) {
      markMobileNativeChatInputStale(handle)
      args.onError?.()
      args.onSendError('Message not sent')
      return false
    }
    const outcome = await args.baseSend(
      args.text,
      args.pendingImages.map((attachment) => attachment.previewUri),
      textDeadline
    )
    if (outcome !== 'accepted') {
      markMobileNativeChatInputStale(handle)
    }
    if (outcome !== 'rejected') {
      args.onSent(new Set(args.pendingImages.map((attachment) => attachment.id)))
      if (!args.client) {
        void args.operations?.releaseImages?.(target!, references).catch(() => {})
      }
    }
    return outcome !== 'rejected'
  } catch {
    markMobileNativeChatInputStale(handle)
    args.onError?.()
    args.onSendError('Message not sent')
    return false
  }
}

async function sendTextAfterStaleInputHeal(
  args: {
    readonly text: string
    readonly client: RpcClient | null
    readonly activeHandleRef: CurrentRef<string | null>
    readonly deviceTokenRef: CurrentRef<string | null>
    readonly connState: ConnectionState
    readonly enabled: boolean
    readonly operations: HostSessionNativeChatOperations | null
    readonly targetRef: CurrentRef<HostSessionNativeChatTarget | null>
    readonly baseSend: MobileNativeChatImageBaseSend
    readonly onError?: () => void
    readonly onSendError: (message: string) => void
  },
  deadline: number
): Promise<boolean> {
  const staleTerminal = args.activeHandleRef.current
  if (staleTerminal && isMobileNativeChatInputStale(staleTerminal)) {
    const target = args.targetRef.current
    if (
      !args.enabled ||
      args.connState !== 'connected' ||
      (!args.client && (!args.operations || !target))
    ) {
      args.onError?.()
      args.onSendError('Message not sent (disconnected)')
      return false
    }
    const healed = args.client
      ? await healMobileNativeChatStaleInput({
          client: args.client,
          terminal: staleTerminal,
          deviceToken: args.deviceTokenRef.current,
          deadline
        })
      : await args.operations!.prepareCommit(target!, deadline)
    if (!healed || args.activeHandleRef.current !== staleTerminal) {
      args.onError?.()
      args.onSendError('Message not sent')
      return false
    }
  }
  return (await args.baseSend(args.text, undefined, deadline)) !== 'rejected'
}
