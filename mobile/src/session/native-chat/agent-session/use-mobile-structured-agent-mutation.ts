import type { AgentSessionSendResult } from '../../../../../src/shared/agent-session/agent-session-wire'
import { useCallback } from 'react'
import type { StructuredAgentSessionState } from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import {
  requestStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'

export type MobileStructuredAgentMutate = <TValue>(
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>,
  shouldReportError?: () => boolean,
  clientOperationId?: string
) => Promise<StructuredAgentSessionMutationResult<TValue>>

export function useMobileStructuredAgentMutate(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  onSendError: (message: string) => void
  agentName?: string
}): MobileStructuredAgentMutate {
  const { agentName, client, enabled, onSendError, sessionId, stateRef } = args
  return useCallback(
    async <TValue>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      shouldReportError?: () => boolean,
      clientOperationId?: string
    ): Promise<StructuredAgentSessionMutationResult<TValue>> => {
      const current = stateRef.current
      if (!client || !sessionId || !enabled || current.fence === null) {
        return { status: 'rejected' }
      }
      const targetFence = current.fence
      const result = await requestStructuredAgentSessionMutation<TValue>({
        client,
        method,
        fingerprintMethod,
        sessionId,
        expectedRuntimeFence: targetFence,
        fields,
        clientOperationId,
        ...(agentName ? { agentName } : {})
      })
      if (result.status === 'accepted') {
        return {
          status: 'accepted',
          value: result.value,
          sameFence: stateRef.current.fence === targetFence
        }
      }
      if (result.status === 'unknown') {
        return result
      }
      if (shouldReportError?.() !== false) {
        onSendError(result.message)
      }
      return { status: 'rejected' }
    },
    [agentName, client, enabled, onSendError, sessionId, stateRef]
  )
}

export async function sendMobileQueuedMessage(
  mutate: MobileStructuredAgentMutate,
  messageId: string,
  operation?: string
): Promise<AgentSessionSendResult | null> {
  const result = await mutate<AgentSessionSendResult>(
    'agentSession.queuedMessageSend',
    'agentSession.queuedMessageSend',
    { messageId },
    undefined,
    operation
  )
  return result.status === 'accepted' ? result.value : null
}
