import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import type { AgentSessionJournalReads } from './journal-reads'
import { journalSqlReads } from './journal-sql-reads'
import type { StructuredAgentSessionHost } from '../agent-session-wire/host/structured-agent-session-host'

type JournalObservation = { identity: { sessionId: string }; reads: AgentSessionJournalReads }

export async function readTestJournalItems(
  journal: Pick<JournalObservation, 'reads'>
): Promise<AgentJournalRenderItem[]> {
  const items: AgentJournalRenderItem[] = []
  await journal.reads.visitItems(
    {
      kinds: [
        'message',
        'tool-call',
        'diff',
        'approval',
        'question',
        'status',
        'turn',
        'agent-start',
        'agent-handoff'
      ]
    },
    (_id, _sequence, _body, _attribution, item) => items.push(item)
  )
  return items.sort(compareAgentJournalItems)
}

export async function readTestJournalSubmissions(
  journal: Pick<JournalObservation, 'reads'>
): Promise<AgentJournalSubmission[]> {
  const { keys } = await journal.reads.input({ kind: 'capture-keys', present: [] })
  const entries: { submission: AgentJournalSubmission; ordinal: number }[] = []
  for (const key of keys) {
    const identity = parseAgentJournalItemKey(key)
    if (identity?.provider === 'orca') {
      const submission = await journal.reads.submission(identity.clientMessageId)
      if (submission) {
        const { ordinal } = await journal.reads.input({
          kind: 'input-ordinal',
          clientMessageId: submission.clientMessageId
        })
        entries.push({ submission, ordinal })
      }
    }
  }
  return entries
    .sort(
      (left, right) =>
        left.submission.submittedAt - right.submission.submittedAt || left.ordinal - right.ordinal
    )
    .map(({ submission }) => submission)
}

export async function readTestJournalSnapshot(
  journal: JournalObservation
): Promise<AgentJournalSnapshot> {
  return {
    sessionId: journal.identity.sessionId,
    cursor: await journal.reads.cursor(),
    items: await readTestJournalItems(journal),
    submissions: await readTestJournalSubmissions(journal)
  }
}

export async function readTestHostJournal(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<AgentJournalSnapshot> {
  await host.history({ sessionId, direction: 'tail' })
  const reads: AgentSessionJournalReads = journalSqlReads(
    host.deps.journalDatabase.readers,
    sessionId
  )
  return readTestJournalSnapshot({ identity: { sessionId }, reads })
}
