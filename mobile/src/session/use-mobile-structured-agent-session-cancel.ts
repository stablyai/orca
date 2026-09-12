import { useCallback } from 'react'
import type { AgentSessionCancelResult } from '../../../src/shared/agent-session-wire'
import { activeStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-live-turn'
import { AGENT_SESSION_PROMPT_CANCEL_UPDATE_REQUIRED_MESSAGE } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import {
  requestStructuredAgentSessionMutation,
  retainStructuredSessionOperationId
} from './mobile-structured-agent-session-rpc'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion
} from './mobile-structured-agent-prompts'
import type { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'

export function useMobileStructuredAgentSessionCancel(args: {
  client: RpcClient | null
  sessionId: string | null
  sessionKey: string
  enabled: boolean
  promptCancelSupported?: boolean
  stateRef: ReturnType<typeof useMobileStructuredAgentState>['stateRef']
  operationIdsRef: { current: Map<string, string> }
  onSendError: (message: string) => void
  onCancelResolved?: () => void
}): () => void {
  const {
    client,
    sessionId,
    sessionKey,
    enabled,
    promptCancelSupported,
    stateRef,
    operationIdsRef,
    onSendError,
    onCancelResolved
  } = args
  return useCallback(() => {
    const current = stateRef.current
    const turnId = activeStructuredAgentSessionTurnId(current.items)
    const prompt =
      current.items.find(pendingStructuredApproval) ?? current.items.find(pendingStructuredQuestion)
    if (!client || !sessionId || !enabled || current.fence === null || (!turnId && !prompt)) {
      onSendError('Stop not sent')
      return
    }
    if (prompt && promptCancelSupported !== true && !turnId) {
      onSendError(
        promptCancelSupported === false
          ? AGENT_SESSION_PROMPT_CANCEL_UPDATE_REQUIRED_MESSAGE
          : 'Checking desktop capabilities — try again in a moment'
      )
      return
    }
    const fields = {
      ...(turnId ? { turnId } : {}),
      ...(promptCancelSupported && prompt
        ? { prompt: { itemId: prompt.itemId, expectedRevision: prompt.revision } }
        : {})
    }
    const key = `${sessionKey}:agentSession.cancel:${JSON.stringify(fields)}`
    const clientOperationId = retainStructuredSessionOperationId(
      operationIdsRef.current,
      key,
      operationIdsRef.current.get(key)
    )
    void requestStructuredAgentSessionMutation<AgentSessionCancelResult>({
      client,
      method: 'agentSession.cancel',
      fingerprintMethod: 'agentSession.cancel',
      sessionId,
      expectedRuntimeFence: current.fence,
      fields,
      clientOperationId
    }).then((result) => {
      if (result.status !== 'unknown') {
        operationIdsRef.current.delete(key)
      }
      if (result.status === 'unknown') {
        onSendError('Stop unconfirmed — check chat before retrying')
      } else if (result.status === 'refused') {
        onSendError(result.message)
      } else if (result.status === 'failed') {
        onSendError(result.message === 'Request not sent' ? 'Stop not sent' : result.message)
      } else {
        onCancelResolved?.()
      }
    })
  }, [client, enabled, onCancelResolved, onSendError, promptCancelSupported, sessionId, sessionKey])
}
