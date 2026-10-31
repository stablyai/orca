import type { SideChatPermission } from '../../../src/shared/agent-session-side-chat'
import type { AgentJournalSkillRef } from '../../../src/shared/agent-session-journal-types'
import type { StructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../src/shared/agent-session-wire'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../src/shared/agent-session-definitive-refusal'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionCreateParams
} from '../../../src/shared/structured-agent-session-create'
import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-send-mutation'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { hasRuntimeRpcErrorCode } from '../../../src/shared/runtime-rpc-error-code'
import type { RpcClient } from '../transport/rpc-client'
import {
  structuredAgentSessionCreate,
  structuredAgentSupportProbe
} from './mobile-session-launch-operations'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { rememberMobileCreatedStructuredSession } from './mobile-created-structured-sessions'

type StructuredCreateSupport = {
  supported?: boolean
  reason?: 'agent' | 'remote' | 'wsl'
}

const SELECTOR_NOT_RESOLVABLE_CODE = 'selector_not_found'
const CREATE_SUPPORT_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type MobileStructuredAgentLaunchResult =
  | { kind: 'created'; sessionId: string }
  | { kind: 'unsupported'; reason?: StructuredCreateSupport['reason'] }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown'; message: string; sessionId?: string }

const pendingSideChatCreates = new WeakMap<
  RpcClient,
  Map<string, StructuredAgentSessionCreateParams>
>()

function createParamsFor(
  agent: StructuredAgentId,
  worktree: string,
  sideChatOf?: string,
  question?: string,
  skills: readonly AgentJournalSkillRef[] = [],
  permission: SideChatPermission = 'inherit'
): StructuredAgentSessionCreateParams {
  return structuredAgentSessionCreateParams({
    sessionId: createStructuredAgentSessionId(agent, randomV4Uuid),
    worktree,
    agent,
    ...(sideChatOf ? { sideChatOf } : {}),
    ...(sideChatOf && permission === 'read-only'
      ? { options: { permissionMode: 'read-only' } }
      : {}),
    ...(question?.trim()
      ? {
          firstMessage: {
            clientMessageId: structuredSessionOperationId(),
            body: structuredAgentSessionSendBody(question, [], skills)
          }
        }
      : {}),
    randomUuid: randomV4Uuid
  })
}

function unknownCreateResult(
  agent: StructuredAgentId,
  error: unknown
): MobileStructuredAgentLaunchResult {
  const message = error instanceof Error ? error.message.trim() : ''
  return { kind: 'unknown', message: message || unconfirmedMessage(agent) }
}

function unconfirmedMessage(agent: StructuredAgentId): string {
  return `The ${formatAgentTypeLabel(agent)} chat result could not be confirmed.`
}

function failedMessage(agent: StructuredAgentId): string {
  return `Could not open ${formatAgentTypeLabel(agent)} chat.`
}

// Only definitive refusal permits failure/fallback; uncertain creates may already own a session and must not create a sibling.
function classifyCreateRefusal(
  agent: StructuredAgentId,
  code: string,
  message: string
): MobileStructuredAgentLaunchResult {
  if (!isDefinitiveAgentSessionCreateRefusal(code)) {
    return unknownCreateResult(agent, new Error(message))
  }
  return { kind: 'failed', message: message || failedMessage(agent) }
}

export async function createMobileStructuredAgentSession(
  client: RpcClient,
  worktreeId: string,
  agent: StructuredAgentId,
  sideChatOf?: string,
  question?: string,
  skills: readonly AgentJournalSkillRef[] = [],
  permission: SideChatPermission = 'inherit'
): Promise<MobileStructuredAgentLaunchResult> {
  const worktree = `id:${worktreeId}`
  if (!sideChatOf) {
    let supportResponse
    for (let attempt = 0; ; attempt += 1) {
      try {
        supportResponse = await structuredAgentSupportProbe.request(client, { worktree, agent })
      } catch (error) {
        const retryDelayMs = CREATE_SUPPORT_RETRY_DELAYS_MS[attempt]
        if (
          retryDelayMs === undefined ||
          !hasRuntimeRpcErrorCode(error, SELECTOR_NOT_RESOLVABLE_CODE)
        ) {
          return { kind: 'unsupported' }
        }
        await delay(retryDelayMs)
        continue
      }
      const retryDelayMs = CREATE_SUPPORT_RETRY_DELAYS_MS[attempt]
      if (
        retryDelayMs !== undefined &&
        hasRuntimeRpcErrorCode(supportResponse, SELECTOR_NOT_RESOLVABLE_CODE)
      ) {
        await delay(retryDelayMs)
        continue
      }
      break
    }
    if (
      !supportResponse ||
      typeof supportResponse !== 'object' ||
      typeof supportResponse.ok !== 'boolean' ||
      !supportResponse.ok
    ) {
      return { kind: 'unsupported' }
    }
    const support = supportResponse.result as StructuredCreateSupport | null
    if (!support || typeof support !== 'object' || support.supported !== true) {
      return { kind: 'unsupported', reason: support?.reason }
    }
  }

  const key = sideChatOf
    ? JSON.stringify([
        client.getGeneration?.() ?? 0,
        worktree,
        agent,
        sideChatOf,
        question ?? '',
        skills,
        permission
      ])
    : null
  const pending = key
    ? (pendingSideChatCreates.get(client) ?? new Map<string, StructuredAgentSessionCreateParams>())
    : null
  if (pending) {
    pendingSideChatCreates.set(client, pending)
  }
  const params =
    (key ? pending?.get(key) : undefined) ??
    createParamsFor(agent, worktree, sideChatOf, question, skills, permission)
  if (key) {
    pending?.set(key, params)
  }
  const result = await requestMobileStructuredCreate(client, params)
  if (result.kind === 'unknown') {
    return sideChatOf ? { ...result, sessionId: params.envelope.sessionId } : result
  }
  if (key && pending?.get(key) === params) {
    pending.delete(key)
  }
  return result
}

async function requestMobileStructuredCreate(
  client: RpcClient,
  params: StructuredAgentSessionCreateParams
): Promise<MobileStructuredAgentLaunchResult> {
  const { agent } = params
  rememberMobileCreatedStructuredSession(params.envelope.sessionId, params.worktree)
  let response
  try {
    response = await structuredAgentSessionCreate.request(client, params, {
      timeoutMs: params.sideChatOf ? 195_000 : 15_000,
      budgetSpansConnect: true
    })
  } catch {
    // Replay the durable envelope once so a lost acknowledgement cannot create a sibling.
    try {
      response = await structuredAgentSessionCreate.request(client, params, {
        timeoutMs: params.sideChatOf ? 195_000 : 15_000,
        budgetSpansConnect: true
      })
    } catch (retryError) {
      // A second transport error cannot disprove the first attempt committed.
      return unknownCreateResult(agent, retryError)
    }
  }

  // Inspect malformed replies as unconfirmed rather than classifying them as refusals.
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
  }
  if (!response.ok) {
    const error = response.error as { code?: unknown; message?: unknown } | null | undefined
    if (
      !error ||
      typeof error !== 'object' ||
      typeof error.code !== 'string' ||
      typeof error.message !== 'string'
    ) {
      return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
    }
    return classifyCreateRefusal(agent, error.code, error.message)
  }
  const result = response.result as AgentSessionMutationResult<AgentSessionAttachResult>
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
  }
  if (!result.ok) {
    if (
      !result.refusal ||
      typeof result.refusal !== 'object' ||
      typeof result.refusal.code !== 'string' ||
      typeof result.refusal.message !== 'string'
    ) {
      return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
    }
    return classifyCreateRefusal(agent, result.refusal.code, result.refusal.message)
  }
  if (
    !result.value ||
    typeof result.value.sessionId !== 'string' ||
    !result.value.sessionId.trim()
  ) {
    return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
  }
  if (
    params.firstMessage &&
    result.value.firstMessage?.clientMessageId !== params.firstMessage.clientMessageId
  ) {
    return unknownCreateResult(
      agent,
      new Error('The side chat’s first question could not be confirmed.')
    )
  }
  return {
    kind: 'created',
    sessionId: result.value.sessionId
  }
}
