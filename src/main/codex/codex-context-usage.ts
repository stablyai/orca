import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { writeAgentJournalTurnRow } from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { readRecord } from './codex-item-field-readers'
import type { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import { readCodexTurnId } from './codex-structured-thread-facts'
import type { CodexRowAttribution } from './codex-subagent-linkage'

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
  if (!contextUsage) {
    return
  }
  const turnId = readCodexTurnId(input.params) ?? input.activeTurns.current(input.threadId)
  const openTurnId = turnId && input.activeTurns.has(input.threadId, turnId) ? turnId : null
  const scope = openTurnId ? input.attributionFor(input.threadId, openTurnId).turnScope : null
  const identity = scope?.kind === 'turn' ? parseAgentJournalItemKey(scope.turnItemId) : null
  writeAgentJournalTurnRow(
    input.sink,
    identity ? { identity } : { newest: true },
    { contextUsage },
    { publish: true }
  )
}
