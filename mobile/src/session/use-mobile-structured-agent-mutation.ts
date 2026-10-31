import { useCallback, useMemo } from 'react'
import { createAgentSessionFormSubmissions } from '../../../src/shared/agent-session-form-submission'
import { selectAgentSessionCurrentRequests } from '../../../src/shared/agent-session-current-requests'
import { structuredSessionOperationId } from './structured-session-operation-id'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import {
  requestStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'

export type MobileStructuredAgentMutate = <TValue>(
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>,
  shouldReportError?: () => boolean
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
  const formSubmissions = useMemo(() => createAgentSessionFormSubmissions(), [client, sessionId])
  return useCallback(
    async <TValue>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      shouldReportError?: () => boolean
    ): Promise<StructuredAgentSessionMutationResult<TValue>> => {
      const current = stateRef.current
      if (!client || !sessionId || !enabled || current.fence === null) {
        return { status: 'rejected' }
      }
      const submission = formSubmissions.capture({
        method,
        fingerprintMethod,
        sessionId,
        fields,
        fence: current.fence,
        operationId: structuredSessionOperationId,
        liveItemIds: new Set(selectAgentSessionCurrentRequests(current).map((item) => item.itemId))
      })
      const targetFence = submission?.envelope.expectedRuntimeFence ?? current.fence
      const result = await requestStructuredAgentSessionMutation<TValue>({
        client,
        method,
        fingerprintMethod,
        sessionId,
        expectedRuntimeFence: targetFence,
        fields,
        ...(submission ? { clientOperationId: submission.envelope.clientOperationId } : {}),
        ...(agentName ? { agentName } : {})
      })
      const unknown =
        result.status === 'unknown' || (submission?.unknown === true && result.status === 'failed')
      formSubmissions.settle(fields.itemId, submission, unknown)
      if (result.status === 'accepted') {
        return {
          status: 'accepted',
          value: result.value,
          sameFence: stateRef.current.fence === targetFence
        }
      }
      if (unknown) {
        return { status: 'unknown' }
      }
      if (shouldReportError?.() !== false) {
        onSendError(result.message)
      }
      return { status: 'rejected' }
    },
    [agentName, client, enabled, formSubmissions, onSendError, sessionId, stateRef]
  )
}
