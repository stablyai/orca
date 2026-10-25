import { useCallback, type MutableRefObject } from 'react'
import { nativeChatAskRequiresTerminal } from '../../../src/shared/native-chat-agent-support'
import type { RpcClient } from '../transport/rpc-client'
import { sendMobileNativeChatMessageWithOutcome } from './mobile-native-chat-send'

export function useMobileNativeChatCancelAsk(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  agentRef: MutableRefObject<string | null>
  /** Cancels unsent answer groups before issuing Escape. */
  cancelPending: () => void
  onSendError: (message: string) => void
}): () => Promise<boolean> {
  const { client, enabled, handleRef, deviceTokenRef, agentRef, cancelPending, onSendError } = args
  return useCallback(async (): Promise<boolean> => {
    if (nativeChatAskRequiresTerminal(agentRef.current)) {
      cancelPending()
      onSendError('Answer this question in terminal view')
      return false
    }
    const handle = handleRef.current
    if (!client || !handle || !enabled) {
      onSendError('Cancel not sent (disconnected)')
      return false
    }
    cancelPending()
    // Escape never submits the composer, so no stale-input heal: it would consume
    // the marker still protecting the next real message.
    const outcome = await sendMobileNativeChatMessageWithOutcome({
      client,
      terminal: handle,
      text: String.fromCharCode(27),
      enter: false,
      requireWriteSettlement: true,
      ...(deviceTokenRef.current
        ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
        : {})
    })
    if (outcome === 'unknown') {
      // Lost-ack/cutover Escape may have changed the prompt; never invite another with a definite not-sent verdict.
      onSendError('Cancel unconfirmed — check chat before retrying')
    } else if (outcome === 'rejected') {
      onSendError('Cancel not sent')
    }
    return outcome === 'accepted'
  }, [agentRef, cancelPending, client, deviceTokenRef, enabled, handleRef, onSendError])
}
