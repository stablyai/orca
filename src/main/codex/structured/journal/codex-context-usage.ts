import type { AgentSessionContextUsage } from '../../../../shared/agent-session/conversation-context/agent-session-context-usage'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { writeAgentJournalTurnRow } from '../../../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { readRecord } from '../../app-server/codex-item-field-readers'
import type { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import type { CodexRowAttribution } from '../background-work/codex-subagent-linkage'
import type { CodexUsageRawUsage } from '../../../codex-usage/codex-usage-token-delta'

function usageCounter(value: unknown): CodexUsageRawUsage | null {
  const raw = readRecord(value)
  const fields = [
    raw.inputTokens,
    raw.cachedInputTokens,
    raw.outputTokens,
    raw.reasoningOutputTokens,
    raw.totalTokens
  ]
  if (
    !fields.every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
  ) {
    return null
  }
  return {
    inputTokens: Number(raw.inputTokens),
    cachedInputTokens: Number(raw.cachedInputTokens),
    outputTokens: Number(raw.outputTokens),
    reasoningOutputTokens: Number(raw.reasoningOutputTokens),
    totalTokens: Number(raw.totalTokens)
  }
}

function positiveCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

// last.totalTokens measures context, including after compaction; total is cumulative thread spend.
export function readCodexContextUsage(
  params: unknown,
  capturedAt: number
): AgentSessionContextUsage | null {
  const usage = readRecord(readRecord(params).tokenUsage)
  // Every request reads at least the instructions, so zero is no measurement.
  const usedTokens = positiveCount(readRecord(usage.last).totalTokens)
  if (usedTokens === null) {
    return null
  }
  const windowTokens = positiveCount(usage.modelContextWindow)
  if (windowTokens === null) {
    // The reading the journal already holds may be measured against another model's window.
    return { used: { kind: 'unknown', capturedAt } }
  }
  return {
    used: {
      kind: 'report',
      // The frame names no model.
      model: 'unknown',
      usedTokens,
      windowTokens,
      percentage: Math.round((usedTokens / windowTokens) * 100),
      categories: [],
      capturedAt
    }
  }
}

/** Resume can replay usage without an open turn; attach it to the newest row then. */
export function recordCodexContextUsage(input: {
  sink: StructuredAgentSessionEventSink
  activeTurns: Pick<CodexJournalActiveTurns, 'current' | 'has'>
  attributionFor: CodexRowAttribution
  threadId: string
  params: unknown
  capturedAt: number
}): void {
  const contextUsage = readCodexContextUsage(input.params, input.capturedAt)
  const usage = readRecord(readRecord(input.params).tokenUsage)
  const total = usageCounter(usage.total)
  const last = usageCounter(usage.last)
  const turnId = readCodexTurnId(input.params) ?? input.activeTurns.current(input.threadId)
  const openTurnId = turnId && input.activeTurns.has(input.threadId, turnId) ? turnId : null
  const scope = openTurnId ? input.attributionFor(input.threadId, openTurnId).turnScope : null
  const identity = scope?.kind === 'turn' ? parseAgentJournalItemKey(scope.turnItemId) : null
  if (!contextUsage && !(identity && total && last)) {
    return
  }
  writeAgentJournalTurnRow(
    input.sink,
    identity ? { identity } : { newest: true },
    {
      ...(contextUsage ? { contextUsage } : {}),
      ...(identity && total && last
        ? { tokenAccounting: { provider: 'codex' as const, total, last } }
        : {})
    },
    { publish: true }
  )
}
