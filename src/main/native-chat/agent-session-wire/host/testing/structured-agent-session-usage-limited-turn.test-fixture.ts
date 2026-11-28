import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { HOST_TEST_NOW } from './structured-agent-session-host-test-data.test-fixture'

/** A finished root turn ended by its account's usage limit, which resets at `resetsAt` (an
 *  unknown reset when null). */
export async function appendUsageLimitedTurn(
  journal: AgentSessionJournal,
  {
    fence,
    resetsAt,
    name = 'usage-limited',
    at = HOST_TEST_NOW
  }: { fence: number; resetsAt: number | null; name?: string; at?: number }
): Promise<void> {
  const turn = { provider: 'orca' as const, clientMessageId: name }
  await journal.appendItem(
    turn,
    {
      kind: 'turn',
      turnId: name,
      providerTurnId: name,
      state: 'completed',
      outcome: 'failure',
      startedAt: at,
      completedAt: at
    },
    { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `${name}-limit` },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', {
          usageLimit: resetsAt === null ? {} : { resetsAt }
        }),
        { surface: 'row' }
      )
    },
    { fence, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) } }
  )
}
