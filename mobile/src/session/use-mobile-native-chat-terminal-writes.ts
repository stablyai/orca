import { useCallback, type MutableRefObject } from 'react'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'
import { useMobileNativeChatPermissionSend } from './mobile-native-chat-permission-send'
import { useMobileNativeChatAnswerSend } from './use-mobile-native-chat-answer-send'
import { useMobileNativeChatMessageSend } from './use-mobile-native-chat-message-send'
import { useMobileNativeChatStop } from './use-mobile-native-chat-stop'

type MessageSendDrafts = Pick<
  Parameters<typeof useMobileNativeChatMessageSend>[0],
  | 'captureSendOrigin'
  | 'readSeededLaunchDraftSeed'
  | 'clearDraftForSend'
  | 'restoreRejectedDraft'
  | 'acceptSend'
  | 'holdUnconfirmedSend'
>

/** Every write that reaches the agent through its terminal input line: the
 *  composer send, prompt-card answers, permission replies, and stop/cancel. */
export function useMobileNativeChatTerminalWrites(args: {
  operations: HostSessionNativeChatOperations | null
  enabled: boolean
  targetRef: MutableRefObject<HostSessionNativeChatTarget | null>
  agentRef: MutableRefObject<string | null>
  sessionId: string | null
  streamIdentity: string
  commandSendRef: MutableRefObject<(command: string) => void>
  drafts: MessageSendDrafts
  onSendError: (message: string) => void
}) {
  const { operations, enabled, targetRef, agentRef, sessionId, streamIdentity, onSendError } = args

  const { answerAsk, cancelPending } = useMobileNativeChatAnswerSend({
    operations,
    enabled,
    targetRef,
    agentRef,
    sessionId,
    streamIdentity,
    onSendError
  })

  const cancelAsk = useCallback(async (): Promise<boolean> => {
    const target = targetRef.current
    if (!operations || !target || !enabled) {
      onSendError('Cancel not sent (disconnected)')
      return false
    }
    cancelPending()
    const outcome = await operations.respond(target, String.fromCharCode(27), false)
    if (outcome === 'unknown') {
      // Why: the Escape may have landed (ack lost / path cutover) — a definite
      // "not sent" would invite a second Escape into a changed prompt state.
      onSendError('Cancel unconfirmed — check chat before retrying')
    } else if (outcome === 'rejected') {
      onSendError('Cancel not sent')
    }
    return outcome === 'accepted'
  }, [cancelPending, enabled, onSendError, operations, targetRef])

  const respondPermission = useMobileNativeChatPermissionSend({
    operations,
    targetRef,
    enabled,
    onSendError
  })

  const stop = useMobileNativeChatStop({
    operations,
    targetRef,
    enabled,
    streamIdentity,
    cancelPending,
    onSendError
  })

  const { send, sendWithOutcome, answerQuestion, dispatchCommand } = useMobileNativeChatMessageSend(
    {
      operations,
      enabled,
      targetRef,
      agentRef,
      commandSendRef: args.commandSendRef,
      ...args.drafts,
      onSendError
    }
  )

  return {
    answerAsk,
    cancelAsk,
    respondPermission,
    stop,
    send,
    sendWithOutcome,
    answerQuestion,
    dispatchCommand
  }
}
