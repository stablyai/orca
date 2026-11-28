import { describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { messageFixture, target } from './journal-sql-message.test-fixture'
import { JournalSqlScope } from './journal-sql-scope'
import { readJournalDomainPromptItem } from './journal-domain-send-and-prompt-reads'

function prompt(
  sequence: number,
  extra: Pick<AgentJournalMessageItem, 'origin' | 'from'> = {}
): AgentJournalRenderItem {
  return {
    itemId: `prompt-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }], ...extra }
  }
}

const RUN = { origin: 'automation-run' } as const
const MAIL: Pick<AgentJournalMessageItem, 'from'> = {
  from: { kind: 'agent', senders: [], orchestration: null }
}

function journal(...items: AgentJournalRenderItem[]) {
  const fixture = messageFixture()
  items.forEach(fixture.seedItem)
  const scope = new JournalSqlScope(fixture.db, target.sessionId, target.epoch)
  return (end: 'first' | 'last' | 'last-person') =>
    readJournalDomainPromptItem(scope, end)?.itemId ?? null
}

describe('prompt items', () => {
  it("reads the newest prompt a person typed past later mail, never a run's or an agent's", () => {
    const read = journal(prompt(1, RUN), prompt(2), prompt(3, MAIL))
    expect(read('first')).toBe('prompt-1')
    expect(read('last')).toBe('prompt-3')
    expect(read('last-person')).toBe('prompt-2')

    expect(journal(prompt(1, RUN), prompt(2, MAIL))('last-person')).toBeNull()
  })
})
