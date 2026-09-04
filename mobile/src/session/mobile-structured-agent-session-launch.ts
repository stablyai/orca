import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import type { RpcClient } from '../transport/rpc-client'
import { structuredSessionOperationId } from './mobile-structured-agent-session-rpc'

type StructuredCreateSupport = {
  supported?: boolean
  reason?: 'agent' | 'remote' | 'wsl'
}

export type MobileStructuredCodexLaunchResult =
  | { kind: 'created'; sessionId: string }
  | { kind: 'unsupported'; reason?: StructuredCreateSupport['reason'] }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown'; message: string }

type StructuredCreateParams = {
  envelope: {
    sessionId: string
    clientOperationId: string
    expectedRuntimeFence: null
    payloadFingerprint: string
  }
  worktree: string
  agent: 'codex'
}

function createStructuredCodexSessionId(): string {
  return `codex_${createRandomUuid().replaceAll('-', '_')}`
}

function createRandomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

function createStructuredCodexSessionParams(worktreeId: string): StructuredCreateParams {
  const sessionId = createStructuredCodexSessionId()
  const worktree = `id:${worktreeId}`
  const fields = { worktree, agent: 'codex' as const }
  return {
    envelope: {
      sessionId,
      clientOperationId: structuredSessionOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields
      })
    },
    ...fields
  }
}

function unknownCreateResult(error: unknown): MobileStructuredCodexLaunchResult {
  const message = error instanceof Error ? error.message.trim() : ''
  return {
    kind: 'unknown',
    message: message || 'The Codex chat result could not be confirmed.'
  }
}

export async function createMobileStructuredCodexSession(
  client: RpcClient,
  worktreeId: string
): Promise<MobileStructuredCodexLaunchResult> {
  const worktree = `id:${worktreeId}`
  let supportResponse
  try {
    supportResponse = await client.sendRequest('agentSession.createSupport', {
      worktree,
      agent: 'codex'
    })
  } catch {
    // A support probe has no side effect; an unavailable probe safely degrades to terminal chat.
    return { kind: 'unsupported' }
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

  const params = createStructuredCodexSessionParams(worktreeId)
  let response
  try {
    response = await client.sendRequest('agentSession.create', params, {
      timeoutMs: 15_000,
      budgetSpansConnect: true
    })
  } catch {
    // Replay the durable envelope once so a lost acknowledgement cannot create a sibling.
    try {
      response = await client.sendRequest('agentSession.create', params, {
        timeoutMs: 15_000,
        budgetSpansConnect: true
      })
    } catch (retryError) {
      // A second transport error cannot disprove the first attempt committed.
      return unknownCreateResult(retryError)
    }
  }

  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    return unknownCreateResult(new Error('The Codex chat result could not be confirmed.'))
  }
  if (!response.ok) {
    if (
      !response.error ||
      typeof response.error !== 'object' ||
      typeof response.error.code !== 'string'
    ) {
      return unknownCreateResult(new Error('The Codex chat result could not be confirmed.'))
    }
    if (response.error.code === 'agent_session_operation_unknown') {
      return unknownCreateResult(new Error(response.error.message))
    }
    return { kind: 'failed', message: response.error.message || 'Could not open Codex chat.' }
  }
  const result = response.result as AgentSessionMutationResult<AgentSessionAttachResult>
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    return unknownCreateResult(new Error('The Codex chat result could not be confirmed.'))
  }
  if (!result.ok) {
    if (
      !result.refusal ||
      typeof result.refusal !== 'object' ||
      typeof result.refusal.code !== 'string'
    ) {
      return unknownCreateResult(new Error('The Codex chat result could not be confirmed.'))
    }
    if (result.refusal.code === 'agent_session_operation_unknown') {
      return unknownCreateResult(new Error(result.refusal.message))
    }
    return { kind: 'failed', message: result.refusal.message || 'Could not open Codex chat.' }
  }
  if (
    !result.value ||
    typeof result.value.sessionId !== 'string' ||
    !result.value.sessionId.trim()
  ) {
    return unknownCreateResult(new Error('The Codex chat result could not be confirmed.'))
  }
  return { kind: 'created', sessionId: result.value.sessionId }
}
