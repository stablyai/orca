import type { AgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
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
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import { hasRuntimeRpcErrorCode } from '../../../src/shared/runtime-rpc-error-code'
import type { RpcClient } from '../transport/rpc-client'
import { structuredSessionRandomUuid } from './mobile-structured-agent-session-rpc'

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
  | { kind: 'unknown'; message: string }

function createParamsFor(
  agent: AgentSessionHandleProvider,
  worktree: string
): StructuredAgentSessionCreateParams {
  return structuredAgentSessionCreateParams({
    sessionId: createStructuredAgentSessionId(agent, structuredSessionRandomUuid),
    worktree,
    agent,
    randomUuid: structuredSessionRandomUuid
  })
}

function unknownCreateResult(
  agent: AgentSessionHandleProvider,
  error: unknown
): MobileStructuredAgentLaunchResult {
  const message = error instanceof Error ? error.message.trim() : ''
  return { kind: 'unknown', message: message || unconfirmedMessage(agent) }
}

function unconfirmedMessage(agent: AgentSessionHandleProvider): string {
  return `The ${TUI_AGENT_DISPLAY_NAMES[agent]} chat result could not be confirmed.`
}

function failedMessage(agent: AgentSessionHandleProvider): string {
  return `Could not open ${TUI_AGENT_DISPLAY_NAMES[agent]} chat.`
}

/** Only a refusal the host names as definitive may become `failed`; anything else keeps the
 *  outcome unknown so no legacy sibling terminal is created for a session that may exist. */
function classifyCreateRefusal(
  agent: AgentSessionHandleProvider,
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
  agent: AgentSessionHandleProvider
): Promise<MobileStructuredAgentLaunchResult> {
  const worktree = `id:${worktreeId}`
  let supportResponse
  for (let attempt = 0; ; attempt += 1) {
    try {
      supportResponse = await client.sendRequest('agentSession.createSupport', { worktree, agent })
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

  const params = createParamsFor(agent, worktree)
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
      return unknownCreateResult(agent, retryError)
    }
  }

  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
  }
  if (!response.ok) {
    if (
      !response.error ||
      typeof response.error !== 'object' ||
      typeof response.error.code !== 'string'
    ) {
      return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
    }
    return classifyCreateRefusal(agent, response.error.code, response.error.message)
  }
  const result = response.result as AgentSessionMutationResult<AgentSessionAttachResult>
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
  }
  if (!result.ok) {
    if (
      !result.refusal ||
      typeof result.refusal !== 'object' ||
      typeof result.refusal.code !== 'string'
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
  return { kind: 'created', sessionId: result.value.sessionId }
}
