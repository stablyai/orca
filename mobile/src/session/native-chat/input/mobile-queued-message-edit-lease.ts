import {
  startQueuedEditLease,
  type QueuedEditLeaseLoss
} from '../../../../../src/shared/queued-message-edit-lease'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { callAgentSession } from '../agent-session/mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from '../agent-session/structured-session-operation-id'

export function startMobileQueuedEditLease(args: {
  getClient: () => RpcClient | null
  sessionId: string
  messageId: string
  expectedBodyFingerprint: string
  onLost: (loss: QueuedEditLeaseLoss) => void
}) {
  return startQueuedEditLease({
    sessionId: args.sessionId,
    messageId: args.messageId,
    editId: structuredSessionOperationId(),
    expectedBodyFingerprint: args.expectedBodyFingerprint,
    onLost: args.onLost,
    request: (params) => {
      const client = args.getClient()
      return client
        ? callAgentSession(client, 'agentSession.queuedMessageEditHold', params, undefined, {
            failWhenDisconnected: true
          })
        : Promise.reject(new Error('Disconnected'))
    }
  })
}
