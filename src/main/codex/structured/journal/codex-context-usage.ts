import type { AgentSessionContextUsage } from '../../../../shared/agent-session/agent-session-context-usage'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { writeAgentJournalTurnRow } from '../../../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { readRecord } from '../../app-server/codex-item-field-readers'
import type { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import type { CodexRowAttribution } from '../background-work/codex-subagent-linkage'
import type { AgentSessionExecutionUsage } from '../../../../shared/agent-session/agent-session-execution-evidence'

export function readCodexCumulativeUsage(
  params: unknown,
  threadId: string,
  observedAt: number,
  previous?: AgentSessionExecutionUsage
): AgentSessionExecutionUsage | undefined {
  const total = readRecord(readRecord(readRecord(params).tokenUsage).total)
  const fields = [
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningOutputTokens'
  ] as const
  if (
    fields.some(
      (key) =>
        !Number.isSafeInteger(total[key]) ||
        Number(total[key]) < 0 ||
        (previous !== undefined && Number(total[key]) < previous[key])
    )
  ) {
    return undefined
  }
  const [totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens] =
    fields.map((key) => Number(total[key]))
  if (
    totalTokens! < inputTokens! + outputTokens! ||
    cachedInputTokens! > inputTokens! ||
    totalTokens! < (previous?.totalTokens ?? 0) ||
    reasoningOutputTokens! > totalTokens!
  ) {
    return undefined
  }
  return {
    threadId,
    observedAt,
    totalTokens: totalTokens!,
    inputTokens: inputTokens!,
    cachedInputTokens: cachedInputTokens!,
    outputTokens: outputTokens!,
    reasoningOutputTokens: reasoningOutputTokens!
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
