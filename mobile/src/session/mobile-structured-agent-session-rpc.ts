import type {
  AgentSessionMutationResult,
  AgentSessionWireRefusalCode
} from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import {
  agentSessionRefusalNotice,
  agentSessionWriteFailureNotice,
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts
} from '../../../src/shared/agent-session-refusal-notice'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  agentSessionWriteKindForMethod,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteKind
} from '../../../src/shared/agent-session-write-failure'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS } from './mobile-native-chat-send'

export const STRUCTURED_SEND_TIMEOUT_MS = 15_000

export type StructuredAgentSessionMutationCallResult<TValue> =
  | { status: 'accepted'; value: TValue }
  | { status: 'refused'; code: AgentSessionWireRefusalCode; message: string }
  | { status: 'failed'; message: string }
  | { status: 'unknown' }

export type StructuredAgentSessionMutationResult<TValue> =
  | { status: 'accepted'; value: TValue; sameFence: boolean }
  | { status: 'rejected' }
  | { status: 'unknown' }

export type StructuredAgentSessionMutate = <TValue>(
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>
) => Promise<StructuredAgentSessionMutationResult<TValue>>

class AgentSessionRpcResponseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** A thrown refusal's reason rides here; its message is only the bare code. */
    readonly data?: unknown
  ) {
    super(message)
  }
}

/** The refusal a failed read met, from a thrown error or a stream's error frame. */
export function agentSessionReadFailureRefusal(failure: unknown) {
  return readAgentSessionErrorRefusal(
    typeof failure === 'object' && failure !== null && 'error' in failure ? failure.error : failure
  )
}

/** A failed read of a chat's history as the pane shows it, from a thrown error or a stream's error
 *  frame (`{ message, error }`): a thrown refusal's message is its bare code, so its words come
 *  from the refusal in the error's data. */
export function agentSessionReadFailureText(failure: unknown): string {
  const refusal = agentSessionReadFailureRefusal(failure)
  if (refusal) {
    return agentSessionWriteNoticeEnglish(
      agentSessionWriteNoticeParts(agentSessionRefusalFailure(refusal), 'read-history')
    )
  }
  if (failure instanceof Error) {
    return failure.message
  }
  return typeof failure === 'object' && failure !== null
    ? 'message' in failure
      ? String(failure.message ?? '')
      : ''
    : String(failure)
}

export async function callAgentSession<TResult>(
  client: RpcClient,
  method: string,
  params: unknown,
  timeoutMs = STRUCTURED_SEND_TIMEOUT_MS,
  options?: { failWhenDisconnected?: boolean }
): Promise<TResult> {
  const response = await client.sendRequest(method, params, {
    timeoutMs,
    budgetSpansConnect: true,
    ...(options?.failWhenDisconnected ? { failWhenDisconnected: true } : {})
  })
  if (!response.ok) {
    throw new AgentSessionRpcResponseError(
      response.error.code,
      response.error.message,
      response.error.data
    )
  }
  return response.result as TResult
}

export function timeoutForDeadline(deadline: number | undefined): number | null {
  if (deadline === undefined) {
    return STRUCTURED_SEND_TIMEOUT_MS
  }
  const timeoutMs = deadline - Date.now()
  return timeoutMs >= MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS ? timeoutMs : null
}

/** A refused phone send goes back into the composer; there is no Retry control. */
function phoneWriteKind(
  fingerprintMethod: string,
  fields: Record<string, unknown>
): AgentSessionWriteKind {
  const write = agentSessionWriteKindForMethod(fingerprintMethod, fields)
  return write === 'send' ? 'composer-send' : write
}

export async function requestStructuredAgentSessionMutation<TValue>(args: {
  client: RpcClient
  method: string
  fingerprintMethod: string
  sessionId: string
  expectedRuntimeFence: number
  fields: Record<string, unknown>
  clientOperationId?: string
  timeoutMs?: number
  agentName?: string
}): Promise<StructuredAgentSessionMutationCallResult<TValue>> {
  const {
    client,
    method,
    fingerprintMethod,
    sessionId,
    expectedRuntimeFence,
    fields,
    clientOperationId,
    timeoutMs,
    agentName
  } = args
  try {
    const result = await callAgentSession<AgentSessionMutationResult<TValue>>(
      client,
      method,
      {
        envelope: {
          sessionId,
          clientOperationId: clientOperationId ?? structuredSessionOperationId(),
          expectedRuntimeFence,
          payloadFingerprint: structuredAgentSessionPayloadFingerprint({
            method: fingerprintMethod,
            sessionId,
            fields
          })
        },
        ...fields
      },
      timeoutMs
    )
    if (
      !result.ok &&
      (method === 'agentSession.cancel' || method === 'agentSession.conversationCommand') &&
      result.refusal.code === 'agent_session_operation_unknown'
    ) {
      return { status: 'unknown' }
    }
    return result.ok
      ? { status: 'accepted', value: result.value }
      : {
          status: 'refused',
          code: result.refusal.code,
          message: agentSessionRefusalNotice(
            result.refusal,
            phoneWriteKind(fingerprintMethod, fields),
            { agentName }
          )
        }
  } catch (error) {
    const answered =
      error instanceof AgentSessionRpcResponseError
        ? agentSessionThrownFailure(error, error.code)
        : null
    if (answered && answered.kind !== 'unconfirmed') {
      // The host turned the request away before running it; its text is written for a log.
      return {
        status: 'failed',
        message: agentSessionWriteNoticeEnglish(
          agentSessionWriteNoticeParts(answered, phoneWriteKind(fingerprintMethod, fields), {
            agentName
          })
        )
      }
    }
    if (
      isRpcDeliveryUnknown(error) ||
      isLogicalClientCutoverError(error) ||
      error instanceof AgentSessionRpcResponseError
    ) {
      return { status: 'unknown' }
    }
    return {
      status: 'failed',
      message: agentSessionWriteFailureNotice(phoneWriteKind(fingerprintMethod, fields))
    }
  }
}
