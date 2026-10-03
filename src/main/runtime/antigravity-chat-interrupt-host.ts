import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import {
  AGENT_INTERRUPT_SETTLE_MS,
  type AgentInterruptInferenceRequest
} from '../../shared/agent-interrupt-intent'
import type {
  AntigravityChatInterruptRequest,
  AntigravityChatInterruptResult
} from '../../shared/antigravity-chat-interrupt'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import { waitForTerminalWriteDelay } from './runtime-terminal-writer'

export type AntigravityInterruptBinding = {
  ptyId: string
  generation: number
  row: AgentStatusIpcPayload
}

type Dependencies = {
  supported(): boolean
  readBinding(terminal: string): AntigravityInterruptBinding | null
  write(binding: AntigravityInterruptBinding): Promise<WriteSettlement>
  infer(request: AgentInterruptInferenceRequest): boolean
}

function matches(request: AntigravityChatInterruptRequest, row: AgentStatusIpcPayload): boolean {
  const expected = request.observation
  const current = row.observation
  return Boolean(
    row.agentType === 'antigravity' &&
    row.state === 'working' &&
    !row.restoredUnconfirmed &&
    !row.providerSessionOnly &&
    row.providerSession?.key === 'conversation_id' &&
    row.providerSession.id === request.providerSessionId &&
    Date.now() - row.receivedAt <= AGENT_STATUS_STALE_AFTER_MS &&
    current &&
    current.authorityId === expected.authorityId &&
    current.incarnation === expected.incarnation &&
    current.revision === expected.revision
  )
}

/** Coalesce only pending operations; canonical status stays in the hook server. */
export function createAntigravityChatInterruptHost(deps: Dependencies) {
  const pending = new Map<string, Promise<AntigravityChatInterruptResult>>()
  const refused = (
    reason: AntigravityChatInterruptResult['reason']
  ): AntigravityChatInterruptResult => ({ accepted: false, inferred: false, reason })

  async function execute(
    request: AntigravityChatInterruptRequest,
    binding: AntigravityInterruptBinding
  ): Promise<AntigravityChatInterruptResult> {
    const settlement = await deps.write(binding)
    if (settlement.outcome !== 'accepted') {
      return refused(settlement.outcome)
    }
    await waitForTerminalWriteDelay(AGENT_INTERRUPT_SETTLE_MS)
    const current = deps.readBinding(request.terminal)
    if (
      !current ||
      current.ptyId !== binding.ptyId ||
      current.generation !== binding.generation ||
      !matches(request, current.row)
    ) {
      return { accepted: true, inferred: false, reason: 'stale' }
    }
    const row = binding.row
    return {
      accepted: true,
      inferred: deps.infer({
        paneKey: row.paneKey,
        baselineAgentType: 'antigravity',
        baselinePrompt: row.prompt,
        baselineUpdatedAt: row.receivedAt,
        baselineStateStartedAt: row.stateStartedAt,
        intent: 'plain-escape'
      })
    }
  }

  return (request: AntigravityChatInterruptRequest): Promise<AntigravityChatInterruptResult> => {
    if (!deps.supported()) {
      return Promise.resolve(refused('unsupported'))
    }
    const binding = deps.readBinding(request.terminal)
    if (!binding || !matches(request, binding.row)) {
      return Promise.resolve(refused('stale'))
    }
    const key = JSON.stringify([
      request.terminal,
      request.providerSessionId,
      request.observation.authorityId,
      request.observation.incarnation,
      request.observation.revision
    ])
    const existing = pending.get(key)
    if (existing) {
      return existing
    }
    const operation = execute(request, binding).finally(() => pending.delete(key))
    pending.set(key, operation)
    return operation
  }
}
