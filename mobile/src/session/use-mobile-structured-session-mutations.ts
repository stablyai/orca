import * as ExpoCrypto from 'expo-crypto'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionHandoffDirection,
  AgentSessionHandoffMode,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionPromptResult
} from '../../../src/shared/agent-session-wire'
import { agentSessionRefusalOperationState } from '../../../src/shared/agent-session-refusal-retry'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'

export type MobileStructuredPromptItem = AgentJournalRenderItem & {
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
}

export type MobileStructuredSessionMutations = {
  respondToPrompt: (item: MobileStructuredPromptItem, optionId: string) => Promise<boolean>
  setOption: (key: string, value: string) => Promise<AgentSessionOptionResult | null>
  cancel: (turnId: string) => Promise<boolean>
  requestHandoff: (
    direction: AgentSessionHandoffDirection,
    mode: AgentSessionHandoffMode,
    action?: 'start' | 'cancel-queued' | 'retry' | 'recover'
  ) => Promise<boolean>
}

export function useMobileStructuredSessionMutations(args: {
  client: RpcClient | null
  sessionId: string | null
  fence: number | null
  handoffOperationId?: string | null
  onRefusal: (message: string | null) => void
}): MobileStructuredSessionMutations {
  const operationIdsRef = useRef(new Map<string, string>())
  const activeContextRef = useRef({
    client: args.client,
    fence: args.fence,
    sessionId: args.sessionId
  })
  const { client, fence, onRefusal, sessionId } = args
  useEffect(() => {
    activeContextRef.current = { client, fence, sessionId }
  }, [client, fence, sessionId])
  const mutate = useCallback(
    async <TValue>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      operationIdOverride?: string | null
    ) => {
      if (!client || !sessionId || fence === null || client.getState() !== 'connected') {
        return null
      }
      const mutationKey = `${sessionId}:${fingerprintMethod}:${JSON.stringify(fields)}`
      const clientOperationId =
        operationIdOverride ??
        operationIdsRef.current.get(mutationKey) ??
        createStructuredAgentSessionOperationId(() => ExpoCrypto.randomUUID())
      operationIdsRef.current.set(mutationKey, clientOperationId)
      let response
      try {
        response = await client.sendRequest(method, {
          envelope: {
            sessionId,
            clientOperationId,
            expectedRuntimeFence: fence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: fingerprintMethod,
              sessionId,
              fields
            })
          },
          ...fields
        })
      } catch (error) {
        if (matchesActiveContext(activeContextRef.current, client, sessionId, fence)) {
          onRefusal(
            isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
              ? 'Response delivery unconfirmed'
              : error instanceof Error
                ? error.message
                : 'Request was not sent'
          )
        }
        return null
      }
      if (!response.ok) {
        if (matchesActiveContext(activeContextRef.current, client, sessionId, fence)) {
          onRefusal(response.error.message)
        }
        return null
      }
      const result = response.result as AgentSessionMutationResult<TValue>
      if (!result.ok) {
        if (
          agentSessionRefusalOperationState(fingerprintMethod, result.refusal.code) ===
          'settled-rejected'
        ) {
          operationIdsRef.current.delete(mutationKey)
        }
        if (matchesActiveContext(activeContextRef.current, client, sessionId, fence)) {
          onRefusal(result.refusal.message)
        }
        return null
      }
      operationIdsRef.current.delete(mutationKey)
      if (matchesActiveContext(activeContextRef.current, client, sessionId, fence)) {
        onRefusal(null)
      }
      return result.value
    },
    [client, fence, onRefusal, sessionId]
  )

  return useMemo(
    () => ({
      respondToPrompt: async (item: MobileStructuredPromptItem, optionId: string) =>
        Boolean(
          await mutate<AgentSessionPromptResult>(
            item.body.kind === 'approval'
              ? 'agentSession.respondToApproval'
              : 'agentSession.respondToQuestion',
            `agentSession.respondTo:${item.body.kind}`,
            { itemId: item.itemId, expectedRevision: item.revision, optionId }
          )
        ),
      setOption: (key: string, value: string) =>
        mutate<AgentSessionOptionResult>('agentSession.setOption', 'agentSession.setOption', {
          key,
          value
        }),
      cancel: async (turnId: string) =>
        Boolean(await mutate('agentSession.cancel', 'agentSession.cancel', { turnId })),
      requestHandoff: async (
        direction: AgentSessionHandoffDirection,
        mode: AgentSessionHandoffMode,
        action: 'start' | 'cancel-queued' | 'retry' | 'recover' = 'start'
      ) =>
        Boolean(
          await mutate(
            'agentSession.requestHandoff',
            'agentSession.requestHandoff',
            { direction, mode, action },
            action === 'retry' ? args.handoffOperationId : null
          )
        )
    }),
    [args.handoffOperationId, mutate]
  )
}

function matchesActiveContext(
  active: { client: RpcClient | null; sessionId: string | null; fence: number | null },
  client: RpcClient,
  sessionId: string,
  fence: number
): boolean {
  return active.client === client && active.sessionId === sessionId && active.fence === fence
}
