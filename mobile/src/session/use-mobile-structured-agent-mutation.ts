// The one mutation seam the structured session hook hands its features: builds
// the envelope, retains replayable operation ids per intent, and folds refusals
// into the session's error channel.

import { useCallback } from 'react'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import {
  requestStructuredAgentSessionMutation,
  retainStructuredSessionOperationId,
  type StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'

export type MobileStructuredAgentMutate = <TValue>(
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>
) => Promise<StructuredAgentSessionMutationResult<TValue>>

export function useMobileStructuredAgentMutate(args: {
  client: RpcClient | null
  sessionId: string | null
  sessionKey: string
  enabled: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  operationIds: Map<string, string>
  onSendError: (message: string) => void
}): MobileStructuredAgentMutate {
  const { client, enabled, onSendError, operationIds, sessionId, sessionKey, stateRef } = args
  return useCallback(
    async <TValue>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>
    ): Promise<StructuredAgentSessionMutationResult<TValue>> => {
      const current = stateRef.current
      if (!client || !sessionId || !enabled || current.fence === null) {
        return { status: 'rejected' }
      }
      const targetFence = current.fence
      const key = `${sessionKey}:${fingerprintMethod}:${JSON.stringify(fields)}`
      const clientOperationId = retainStructuredSessionOperationId(
        operationIds,
        key,
        operationIds.get(key)
      )
      const result = await requestStructuredAgentSessionMutation<TValue>({
        client,
        method,
        fingerprintMethod,
        sessionId,
        expectedRuntimeFence: targetFence,
        fields,
        clientOperationId
      })
      if (result.status === 'accepted') {
        operationIds.delete(key)
        return {
          status: 'accepted',
          value: result.value,
          sameFence: stateRef.current.fence === targetFence
        }
      }
      if (result.status === 'unknown') {
        operationIds.delete(key)
        return result
      }
      operationIds.delete(key)
      onSendError(result.message)
      return { status: 'rejected' }
    },
    [client, enabled, onSendError, operationIds, sessionId, sessionKey, stateRef]
  )
}
