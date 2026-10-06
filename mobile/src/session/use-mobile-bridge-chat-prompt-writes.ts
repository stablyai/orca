import type { MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileNativeChatPermissionSend } from './mobile-native-chat-permission-send'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useMobileNativeChatCancelAsk } from './use-mobile-native-chat-cancel-ask'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'
import type { MobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'

/** The bridge lane's four prompt/interrupt write seams. They share one enable
 *  gate and chain through the answer seam's `cancelPending`, so a caller cannot
 *  wire one of them to a different lane or forget to drop in-flight answer
 *  writes before an Escape. The structured lane answers over RPC instead. */
export function useMobileBridgeChatPromptWrites(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  agentRef: MutableRefObject<string | null>
  /** Changes on chat session swap; cancels pending writes when it does. */
  sessionId: string | null
  streamIdentity: string
  onSendError: (message: string) => void
}): {
  answerAsk: MobileNativeChatAnswerSend['answerAsk']
  cancelAsk: () => Promise<boolean>
  respondPermission: (send: string) => Promise<boolean>
  stop: () => void
} {
  const { client, enabled, handleRef, deviceTokenRef, streamIdentity, onSendError } = args
  const { answerAsk, cancelPending } = useMobileNativeChatAnswerSend({
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    agentRef: args.agentRef,
    sessionId: args.sessionId,
    streamIdentity,
    onSendError
  })
  const cancelAsk = useMobileNativeChatCancelAsk({
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    cancelPending,
    onSendError
  })
  const respondPermission = useMobileNativeChatPermissionSend({
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    onSendError
  })
  const stop = useMobileNativeChatStop({
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    streamIdentity,
    cancelPending,
    onSendError
  })
  return { answerAsk, cancelAsk, respondPermission, stop }
}
