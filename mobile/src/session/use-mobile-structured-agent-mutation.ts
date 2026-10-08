// The one mutation seam the structured session hook hands its features: builds
// the envelope, with a fresh operation id per call, and folds refusals into the
// session's error channel.

import { useCallback } from 'react'
import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import {
  requestStructuredAgentSessionMutation,
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
  enabled: boolean
  stateRef: { readonly current: StructuredAgentSessionState }
  onSendError: (message: string) => void
}): MobileStructuredAgentMutate {
  const { client, enabled, onSendError, sessionId, stateRef } = args
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
      const result = await requestStructuredAgentSessionMutation<TValue>({
        client,
        method,
        fingerprintMethod,
        sessionId,
        expectedRuntimeFence: targetFence,
        fields
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
      onSendError(result.message)
      return { status: 'rejected' }
    },
    [client, enabled, onSendError, sessionId, stateRef]
  )
}
