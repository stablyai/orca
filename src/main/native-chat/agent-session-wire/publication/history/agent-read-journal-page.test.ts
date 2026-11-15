import { afterEach, expect, it } from 'vitest'
import {
  messageFixture,
  target
} from '../../../agent-session-journal/journal-sql-message.test-fixture'
import { readJournalDomainHistoryPage } from '../../../agent-session-journal/journal-domain-history-page'
import { readJournalDomainItems } from '../../../agent-session-journal/journal-sql-item-reads'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
import { readAgentJournalPage } from './agent-read-journal-page'

const databases: ReturnType<typeof messageFixture>['db'][] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const f = messageFixture()
  databases.push(f.db)
  const counts = { pages: 0, bodies: 0 }
  let beforeHistory = () => {}
  const journal: Pick<SqlAgentSessionJournal, 'history'> & {
    reads: Pick<SqlAgentSessionJournal['reads'], 'contextFloor'>
  } = {
    reads: {
      contextFloor: async () => {
        const result = readJournalDomainItems(f.db, target, { kind: 'context-floor' })
        return result.kind === 'context-floor' ? result.floor : null
      }
    },
    history: async (request) => {
      beforeHistory()
      counts.pages++
      const result = readJournalDomainHistoryPage(
        f.db,
        { ...request, sessionId: target.sessionId },
        {
          ...CLIENT_HISTORY_READER,
          form: (item) => {
            counts.bodies++
            return CLIENT_HISTORY_READER.form(item)
          }
        }
      )
      return { result }
    }
  }
  return {
    ...f,
    counts,
    beforeHistory: (run: () => void) => {
      beforeHistory = run
    },
    head: (sequence: number) =>
      f.db.prepare('UPDATE journal_chat_state SET last_sequence=?').run(sequence),
    read: (limit = 20) =>
      readAgentJournalPage(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter uses only these real SQLite-backed reads.
        journal as SqlAgentSessionJournal,
        { sessionId: 'chat', limit },
        () => true
      )
  }
}

function message(sequence: number, text: string, agentId?: string): AgentJournalRenderItem {
  return {
    itemId: `orca:${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    turnScope: { kind: 'thread' },
    ...(agentId ? { agentId } : {})
  }
}

function clear(f: ReturnType<typeof fixture>) {
  f.seedItem({
    ...message(2, ''),
    body: {
      kind: 'status',
      text: 'Context cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 2 }
    }
  })
  f.seedItem(message(3, 'new context'))
  f.db.prepare('UPDATE journal_chat_state SET last_sequence=3, context_boundary=2').run()
}

it.each([4_000, 40_000])('bounds repeated root reads behind %i subagent rows', async (n) => {
  const f = fixture()
  f.seedItem(message(1, 'old context'))
  clear(f)
  f.seedItem(message(4, 'latest reply'))
  f.db.exec('BEGIN')
  for (let i = 5; i < n + 5; i++) {
    f.seedItem(message(i, 'child work', 'child'))
  }
  f.db.exec('COMMIT')
  f.head(n + 4)

  for (let repeat = 0; repeat < 2; repeat++) {
    f.counts.pages = 0
    f.counts.bodies = 0
    expect(await f.read()).toEqual({
      entries: [
        { kind: 'message', role: 'system', text: 'Context cleared' },
        { kind: 'message', role: 'assistant', text: 'new context' },
        { kind: 'message', role: 'assistant', text: 'latest reply' }
      ],
      limited: false
    })
    expect(f.counts).toEqual({ pages: 1, bodies: 4 })
  }
  expect(await f.read(1)).toEqual({
    entries: [{ kind: 'message', role: 'assistant', text: 'latest reply' }],
    limited: true
  })
})

it('takes the clear boundary from the history snapshot, including a clear just before it', async () => {
  const f = fixture()
  f.seedItem(message(1, 'old context'))
  f.head(1)
  f.beforeHistory(() => clear(f))
  expect(await f.read()).toEqual({
    entries: [
      { kind: 'message', role: 'system', text: 'Context cleared' },
      { kind: 'message', role: 'assistant', text: 'new context' }
    ],
    limited: false
  })
})

it('reports the byte stop and preserves an oversized-item notice as incomplete', async () => {
  const f = fixture()
  f.seedItem(message(1, 'a'.repeat(1_200_000)))
  f.seedItem(message(2, 'b'.repeat(1_200_000)))
  f.head(2)
  const page = await f.read()
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0]).toEqual({
    kind: 'message',
    role: 'assistant',
    text: 'b'.repeat(1_200_000)
  })
  expect(page.limited).toBe(true)

  f.seedItem({
    ...message(3, ''),
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: Array.from({ length: 100_000 }, () => ({ type: 'text', text: 'x' }))
    }
  })
  f.head(3)
  expect(await f.read()).toEqual({
    entries: [
      {
        kind: 'message',
        role: 'system',
        text: 'This part of the chat was too large to show.',
        shortened: true
      }
    ],
    limited: true
  })
})

it('finds the requested entries behind non-entry root rows', async () => {
  const f = fixture()
  f.seedItem(message(1, 'older reply'))
  f.seedItem(message(2, 'latest reply'))
  for (let sequence = 3; sequence <= 12; sequence++) {
    f.seedItem({ ...message(sequence, ''), body: { kind: 'status', text: 'working' } })
  }
  f.head(12)
  expect(await f.read(1)).toEqual({
    entries: [{ kind: 'message', role: 'assistant', text: 'latest reply' }],
    limited: true
  })
  expect(await f.read(2)).toEqual({
    entries: [
      { kind: 'message', role: 'assistant', text: 'older reply' },
      { kind: 'message', role: 'assistant', text: 'latest reply' }
    ],
    limited: false
  })
})

it('bounds a root-only tail that produces no entries', async () => {
  const f = fixture()
  f.seedItem(message(1, 'older reply'))
  for (let sequence = 2; sequence <= 1_000; sequence++) {
    f.seedItem({ ...message(sequence, ''), body: { kind: 'status', text: 'working' } })
  }
  f.head(1_000)
  expect(await f.read(1)).toEqual({ entries: [], limited: true })
  expect(f.counts).toEqual({ pages: 1, bodies: 200 })
})
