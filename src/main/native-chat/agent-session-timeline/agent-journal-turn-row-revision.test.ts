import { expect, it } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentJournalTurnItem
} from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionRevisionJournal } from '../agent-session-wire/structured-agent-session-event-sink'
import { resolveAgentJournalTurnRowWrite } from './agent-journal-turn-row-revision'

const identity: AgentJournalItemIdentity = {
  provider: 'legacy',
  agent: 'claude',
  sessionId: 'session',
  recordId: 'turn-lifecycle:turn-1'
}

function journalHolding(body: AgentJournalTurnItem): StructuredAgentSessionRevisionJournal {
  return { epoch: 'epoch', visitItems: () => {}, itemBody: () => body }
}

it('drops a turn’s fork point when its end is rewritten without one, and keeps what the end does not own', () => {
  const ended: AgentJournalTurnItem = {
    kind: 'turn',
    turnId: 'turn-1',
    state: 'completed',
    outcome: 'success',
    forkPoint: 'leaf-of-the-first-end',
    providerTurnId: 'provider-turn-1'
  }
  // The same turn ended again, this time on nothing the assistant wrote.
  const rewritten: AgentJournalTurnItem = {
    kind: 'turn',
    turnId: 'turn-1',
    state: 'completed',
    outcome: 'success'
  }

  const write = resolveAgentJournalTurnRowWrite(
    journalHolding(ended),
    { identity },
    { lifecycle: rewritten },
    64 * 1024
  )

  expect(write?.body).toEqual({ ...rewritten, providerTurnId: 'provider-turn-1' })
})
