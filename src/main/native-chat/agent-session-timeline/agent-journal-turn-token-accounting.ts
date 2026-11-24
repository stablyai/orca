import type {
  AgentSessionTurnTokenAccounting,
  AgentSessionTurnTokenCounts
} from '../../../shared/agent-session/conversation-context/agent-session-turn-token-accounting'
import {
  resolveCodexUsageDelta,
  type CodexUsageRawUsage
} from '../../codex-usage/codex-usage-token-delta'

export type AgentJournalTurnTokenWrite =
  | { provider: 'claude'; tokens: AgentSessionTurnTokenCounts }
  | { provider: 'codex'; total: CodexUsageRawUsage; last: CodexUsageRawUsage }

export function reviseAgentJournalTurnTokens(
  previous: AgentSessionTurnTokenAccounting | undefined,
  write: AgentJournalTurnTokenWrite
): AgentSessionTurnTokenAccounting {
  if (write.provider === 'claude') {
    return { provider: 'claude', scope: 'reported_root_turn', tokens: write.tokens }
  }
  const prior = previous?.provider === 'codex' ? previous : undefined
  const delta = resolveCodexUsageDelta(write.total, write.last, prior?.previousTotals ?? null)
  if (!delta) {
    return prior ?? { provider: 'codex', scope: 'reported_root_turn', tokens: null }
  }
  if (delta.kind !== 'event' || (prior && prior.tokens === null)) {
    return {
      provider: 'codex',
      scope: 'reported_root_turn',
      tokens: null,
      previousTotals: delta.nextTotals ?? write.total
    }
  }
  const counts = delta.delta
  if (
    counts.cachedInputTokens > counts.inputTokens ||
    counts.reasoningOutputTokens > counts.outputTokens
  ) {
    return {
      provider: 'codex',
      scope: 'reported_root_turn',
      tokens: null,
      previousTotals: write.total
    }
  }
  const old = prior?.tokens
  return {
    provider: 'codex',
    scope: 'reported_root_turn',
    previousTotals: delta.nextTotals ?? write.total,
    tokens: {
      uncachedInput: (old?.uncachedInput ?? 0) + counts.inputTokens - counts.cachedInputTokens,
      cacheReadInput: (old?.cacheReadInput ?? 0) + counts.cachedInputTokens,
      cacheWriteInput: 0,
      output: (old?.output ?? 0) + counts.outputTokens,
      reasoningOutputSubset: (old?.reasoningOutputSubset ?? 0) + counts.reasoningOutputTokens
    }
  }
}
