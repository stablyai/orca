import { startQueuedEditLease } from '../../../src/shared/queued-message-edit-lease'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from './structured-session-operation-id'

export type { QueuedEditLease as MobileQueuedEditLease } from '../../../src/shared/queued-message-edit-lease'

export function startMobileQueuedEditLease(args: {
  getClient: () => RpcClient | null
  sessionId: string
  messageId: string
  expectedBodyFingerprint: string
}) {
  return startQueuedEditLease({
    sessionId: args.sessionId,
    messageId: args.messageId,
    editId: structuredSessionOperationId(),
    expectedBodyFingerprint: args.expectedBodyFingerprint,
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
