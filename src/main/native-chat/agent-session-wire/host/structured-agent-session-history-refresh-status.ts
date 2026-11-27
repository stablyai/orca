import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'
import {
  createHistoryCatchUpBatch,
  runHistoryCatchUp
} from '../acquisition/structured-agent-session-history-catch-up'

/** One historical notice per handle and reason; retries neither duplicate it nor claim success. */
export async function recordHistoryRefreshSkipped(input: {
  sessionId: string
  sink: StructuredAgentSessionEventSink
  signal: AbortSignal
  assertCurrent: () => void
  cursor: AgentJournalCursor
  head: string
  reason: string
}): Promise<void> {
  const reason =
    input.reason === 'too-large'
      ? 'too-large'
      : input.reason === 'timeout'
        ? 'timeout'
        : input.reason === 'unsupported'
          ? 'unsupported'
          : 'failed'
  const explanation = {
    'too-large': 'it exceeds the safe import limit',
    timeout: 'the history read timed out',
    unsupported: 'read-only history is unavailable for this host',
    failed: 'the history read failed'
  }[reason]
  const identity = {
    provider: 'orca' as const,
    clientMessageId: `history-refresh:${input.head}:${reason}`
  }
  await runHistoryCatchUp({
    agentName: 'History',
    scope: 'history-refresh-status',
    sessionId: input.sessionId,
    sink: input.sink,
    signal: input.signal,
    assertCurrent: input.assertCurrent,
    timeoutMs: 1_000,
    readView: async () => ({ physicalCursor: input.cursor }),
    prepare: async ({ history }) => {
      if (await history.reads.item(agentJournalItemKey(identity))) {
        return null
      }
      const batch = createHistoryCatchUpBatch()
      batch.push({
        kind: 'item',
        identity,
        turnScope: { kind: 'thread' },
        body: {
          kind: 'status',
          text: `External history was not refreshed: ${explanation}. Local history is unchanged.`
        }
      })
      return { ...batch.finish('history-refresh-status', identity), expectedCursor: input.cursor }
    }
  })
}
