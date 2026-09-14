import {
  AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../src/shared/agent-session-host-authority'
import type {
  AgentSessionMutationResult,
  AgentSessionWireRefusalCode
} from '../../../src/shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
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
    message: string
  ) {
    super(message)
  }
}

const PRE_HANDLER_RPC_REFUSALS = new Set([
  'invalid_argument',
  'method_not_found',
  'method_not_supported',
  'unauthorized'
])

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
    throw new AgentSessionRpcResponseError(response.error.code, response.error.message)
  }
  return response.result as TResult
}

/** React Native has no guaranteed `crypto.randomUUID`; the fallback keeps the same
 *  32-hex entropy shape the durable id and fingerprint helpers validate. */
export function structuredSessionRandomUuid(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

export function structuredSessionOperationId(now: number = Date.now()): string {
  return createStructuredAgentSessionOperationId(structuredSessionRandomUuid, now)
}

function isReplayableStructuredSessionOperationId(operationId: string, now: number): boolean {
  const timestamp = parseAgentSessionOperationTimestamp(operationId)
  return (
    timestamp !== null &&
    timestamp <= now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS &&
    now - timestamp <= AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS
  )
}

/**
 * Retains transient non-send mutation ids while the host can still replay them. Structured sends
 * use the durable journal because delivery ambiguity itself does not expire.
 */
export function retainStructuredSessionOperationId(
  operationIds: Map<string, string>,
  key: string,
  operationId?: string,
  now: number = Date.now()
): string {
  const retainedOperationId =
    operationId && isReplayableStructuredSessionOperationId(operationId, now)
      ? operationId
      : structuredSessionOperationId(now)
  operationIds.delete(key)
  operationIds.set(key, retainedOperationId)
  for (const [retainedKey, retainedId] of operationIds) {
    if (retainedKey === key) {
      continue
    }
    if (!isReplayableStructuredSessionOperationId(retainedId, now)) {
      operationIds.delete(retainedKey)
    }
  }
  return retainedOperationId
}

export function timeoutForDeadline(deadline: number | undefined): number | null {
  if (deadline === undefined) {
    return STRUCTURED_SEND_TIMEOUT_MS
  }
  const timeoutMs = deadline - Date.now()
  return timeoutMs >= MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS ? timeoutMs : null
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
}): Promise<StructuredAgentSessionMutationCallResult<TValue>> {
  const {
    client,
    method,
    fingerprintMethod,
    sessionId,
    expectedRuntimeFence,
    fields,
    clientOperationId,
    timeoutMs
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
      : { status: 'refused', code: result.refusal.code, message: result.refusal.message }
  } catch (error) {
    if (error instanceof AgentSessionRpcResponseError && PRE_HANDLER_RPC_REFUSALS.has(error.code)) {
      return { status: 'failed', message: error.message }
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
      message: error instanceof Error ? error.message : 'Request not sent'
    }
  }
}
