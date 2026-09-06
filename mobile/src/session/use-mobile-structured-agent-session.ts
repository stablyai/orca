import { useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  AgentSessionCancelResult,
  AgentSessionPromptResult,
  AgentSessionSendResult
} from '../../../src/shared/agent-session-wire'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-outbox'
import { encodeNativeChatTranscriptIdentity } from '../../../src/shared/native-chat-transcript-retention'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { activeStructuredAgentSessionTurnId } from '../../../src/shared/structured-agent-session-projection'
import {
  pendingStructuredApproval,
  pendingStructuredQuestion,
  projectStructuredPermission,
  projectStructuredQuestion,
  structuredApprovalResponseTarget,
  structuredQuestionResponseTarget
} from './mobile-structured-agent-prompts'
import {
  requestStructuredAgentSessionMutation,
  retainStructuredSessionOperationId as retainStructuredOpId,
  timeoutForDeadline,
  type StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

type StructuredMobileAttachment = StructuredAgentSessionAttachment & { id?: string }

type StructuredMobileSession = {
  session: MobileNativeChatSession
  isWorking: boolean
  turnId: string | null
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileAttachment[]
  ) => Promise<MobileNativeChatSendOutcome>
  cancel: () => void
  permission: MobileChatPermission | null
  question: MobileChatQuestion | null
  optionSnapshot: SessionOptionDescriptor[]
  optionSurface: SessionOptionsSurface
  pendingOptionId: string | null
  respondPermission: (optionId: string) => Promise<boolean>
  respondQuestion: (answer: string) => Promise<boolean>
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  invokeStructuredOption: (id: string) => Promise<boolean>
}

export function useMobileStructuredAgentSession(args: {
  client: RpcClient | null
  sessionId: string | null
  /** Host/workspace scope used to keep same provider ids isolated. */
  sourceIdentity?: string
  enabled: boolean
  /** Live transport only; gates the connection-scoped hold, nothing else. */
  connected: boolean
  agent: string | null
  onSendError: (message: string) => void
}): StructuredMobileSession {
  const { agent, client, connected, sessionId, sourceIdentity = '', enabled, onSendError } = args
  const sessionKey = encodeNativeChatTranscriptIdentity([sourceIdentity, agent, sessionId])
  const operationIdsRef = useRef(new Map<string, string>())
  useEffect(() => () => operationIdsRef.current.clear(), [])
  const retainOperationId = (key: string, operationId?: string): string =>
    retainStructuredOpId(operationIdsRef.current, key, operationId)
  const stateArgs = { client, sessionId, sessionKey, enabled, connected }
  const { state, stateRef, loadingOlder, loadEarlier } = useMobileStructuredAgentState(stateArgs)

  const mutate = useCallback(
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
      const clientOperationId = retainOperationId(key, operationIdsRef.current.get(key))
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
        operationIdsRef.current.delete(key)
        return {
          status: 'accepted',
          value: result.value,
          sameFence: stateRef.current.fence === targetFence
        }
      }
      if (result.status === 'unknown') {
        // Prompt/option/cancel plans cannot redispatch an unknown ledger row;
        // issue a fresh id so a retry can be admitted after the user checks the
        // stream. Sends opt into explicit retryUnknown below.
        operationIdsRef.current.delete(key)
        return result
      }
      operationIdsRef.current.delete(key)
      onSendError(result.message)
      return { status: 'rejected' }
    },
    [client, enabled, onSendError, sessionId, sessionKey]
  )

  const {
    invokeStructuredOption,
    optionSnapshot,
    optionSurface,
    pendingOptionId,
    setStructuredOption
  } = useMobileStructuredAgentOptions({
    agent,
    client,
    sessionId,
    enabled,
    fence: state.fence,
    mutate
  })

  const sendWithOutcome = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileAttachment[]
    ): Promise<MobileNativeChatSendOutcome> => {
      const currentFence = stateRef.current.fence
      if (!client || !sessionId || !enabled || currentFence === null) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      const timeoutMs = timeoutForDeadline(deadline)
      if (timeoutMs === null) {
        onSendError('Message not sent')
        return 'rejected'
      }
      if (attachments === undefined && images !== undefined && images.length > 0) {
        onSendError('Message not sent')
        return 'rejected'
      }
      const sendAttachments = attachments ?? []
      const body = structuredAgentSessionSendBody(text, sendAttachments)
      if (body.blocks.length === 0) {
        return 'rejected'
      }
      const fields = { body }
      const key = `${sessionKey}:agentSession.send:${JSON.stringify(fields)}`
      const priorOperationId = operationIdsRef.current.get(key)
      const clientOperationId = retainOperationId(key, priorOperationId)
      const result = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
        client,
        method: 'agentSession.send',
        fingerprintMethod: 'agentSession.send',
        sessionId,
        expectedRuntimeFence: currentFence,
        fields,
        clientOperationId,
        ...(priorOperationId ? { retryUnknown: true } : {}),
        timeoutMs
      })
      if (result.status === 'accepted') {
        operationIdsRef.current.delete(key)
        return 'accepted'
      }
      if (result.status === 'unknown') {
        return 'unknown'
      }
      operationIdsRef.current.delete(key)
      onSendError(result.message === 'Request not sent' ? 'Message not sent' : result.message)
      return 'rejected'
    },
    [client, enabled, onSendError, sessionId, sessionKey]
  )

  const respondPermission = useCallback(
    async (optionId: string): Promise<boolean> => {
      const target = structuredApprovalResponseTarget(
        optionId,
        stateRef.current.items.find(pendingStructuredApproval) ?? null
      )
      if (!target) {
        return false
      }
      const result = await mutate<AgentSessionPromptResult>(
        'agentSession.respondToApproval',
        'agentSession.respondTo:approval',
        target
      )
      if (result.status === 'unknown') {
        onSendError('Response unconfirmed — check chat before retrying')
        return false
      }
      return result.status === 'accepted'
    },
    [mutate, onSendError]
  )

  const respondQuestion = useCallback(
    async (answer: string): Promise<boolean> => {
      const target = structuredQuestionResponseTarget(
        answer,
        stateRef.current.items.find(pendingStructuredQuestion) ?? null
      )
      if (!target) {
        return false
      }
      const result = await mutate<AgentSessionPromptResult>(
        'agentSession.respondToQuestion',
        'agentSession.respondTo:question',
        target
      )
      if (result.status === 'unknown') {
        onSendError('Answer unconfirmed — check chat before retrying')
        return false
      }
      return result.status === 'accepted'
    },
    [mutate, onSendError]
  )

  const cancel = useCallback(() => {
    const current = stateRef.current
    const turnId = activeStructuredAgentSessionTurnId(current.items)
    if (!client || !sessionId || !enabled || current.fence === null || !turnId) {
      onSendError('Stop not sent')
      return
    }
    const fields = { turnId }
    const key = `${sessionKey}:agentSession.cancel:${JSON.stringify(fields)}`
    const clientOperationId = retainOperationId(key, operationIdsRef.current.get(key))
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
      }
    })
  }, [client, enabled, onSendError, sessionId, sessionKey])

  const messages = useMemo(
    () => projectStructuredAgentSessionMessages(state.items, [], state.submissions),
    [state.items, state.submissions]
  )
  const status = state.status === 'idle' ? 'idle' : state.status
  const approvalPrompt = useMemo(
    () => state.items.find(pendingStructuredApproval) ?? null,
    [state.items]
  )
  const questionPrompt = useMemo(
    () => state.items.find(pendingStructuredQuestion) ?? null,
    [state.items]
  )

  return {
    session: {
      messages,
      status,
      transcriptLoading: status === 'loading',
      error: state.error,
      hasMore: state.hasOlder,
      loadingEarlier: loadingOlder,
      loadEarlier
    },
    isWorking: activeStructuredAgentSessionTurnId(state.items) !== null,
    turnId: activeStructuredAgentSessionTurnId(state.items),
    sendWithOutcome,
    cancel,
    permission: projectStructuredPermission(approvalPrompt),
    question: projectStructuredQuestion(questionPrompt),
    optionSnapshot,
    optionSurface,
    pendingOptionId,
    respondPermission,
    respondQuestion,
    setStructuredOption,
    invokeStructuredOption
  }
}
