import type { MutableRefObject } from 'react'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileNativeChatPermissionSend } from './mobile-native-chat-permission-send'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useMobileNativeChatCancelAsk } from './use-mobile-native-chat-cancel-ask'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'

/** The terminal-bridge lane's replies to a live agent prompt: answer an ask,
 *  cancel it, respond to a permission request, and stop the turn. All four write
 *  to the same terminal under the same lease, so they share one enablement gate
 *  and one pending-answer cancellation. Structured agent sessions answer through
 *  their provider instead and leave this lane disabled. */
export function useMobileNativeChatTerminalResponseLane(args: {
  client: RpcClient | null
  operations: HostSessionNativeChatOperations | null
  workspaceId: string
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  agentRef: MutableRefObject<string | null>
  sessionId: string | null
  streamIdentity: string
  onSendError: (message: string) => void
}) {
  const {
    client,
    operations,
    workspaceId,
    enabled,
    handleRef,
    deviceTokenRef,
    agentRef,
    sessionId,
    streamIdentity,
    onSendError
  } = args
  const { answerAsk, cancelPending } = useMobileNativeChatAnswerSend({
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    agentRef,
    sessionId,
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
    operations,
    workspaceId,
    enabled,
    handleRef,
    deviceTokenRef,
    streamIdentity,
    cancelPending,
    onSendError
  })
  return { answerAsk, cancelAsk, respondPermission, stop }
}
