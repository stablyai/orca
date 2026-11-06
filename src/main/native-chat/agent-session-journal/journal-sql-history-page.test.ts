import { expect, it } from 'vitest'
import {
  appendItems,
  fixture,
  item,
  body
} from '../agent-session-wire/agent-session-history-contract-test-fixture'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from '../agent-session-wire/agent-session-history-page'
import { measureHistoryItem } from '../agent-session-wire/agent-session-history-page-bounds'
import {
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import { convertJournalSqlProjection } from './journal-sql-conversion'
import { JournalProjectionStaleError } from './journal-sql-meta'
import { readJournalSqlHistoryPage } from './journal-sql-history-page'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { AgentSessionHistoryRequest } from '../../../shared/agent-session/agent-session-wire'
import { join } from 'node:path'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
import { restoreJournal } from './journal-open'
import { renderJournalState } from './journal-reducer'

function convert() {
  const database = openTestJournalHostDatabase(fixture.root)
  database.transaction((db) => convertJournalSqlProjection(db, 'session-1'))
  return database.db
}

it('preserves default, clamped, backward, hydration and reset wire pages from a converted chat', async () => {
  await appendItems(44)
  const db = convert()
  for (const limit of [undefined, 2, 0, 10000]) {
    const request = { sessionId: 'session-1', direction: 'tail', limit } as const
    const actual = readJournalSqlHistoryPage(db, request)
    expect(actual).toEqual(readAgentSessionHistory(fixture.journal, request))
    if (!actual.ok) {
      throw new Error('expected tail')
    }
    const before = {
      ...request,
      direction: 'before',
      cursor: actual.page.window.nextCursor
    } as const
    expect(readJournalSqlHistoryPage(db, before)).toEqual(
      readAgentSessionHistory(fixture.journal, before)
    )
  }
  expect(
    readJournalSqlHistoryPage(db, { sessionId: 'session-1', direction: 'hydrate', fence: 8 })
  ).toEqual({ ok: true, page: readAgentSessionHydrationPage(fixture.journal, 8) })
  for (const cursor of [
    { epoch: 'old', sequence: 2 },
    { epoch: fixture.journal.epoch, sequence: 999 }
  ]) {
    const request = { sessionId: 'session-1', direction: 'before', cursor } as const
    expect(readJournalSqlHistoryPage(db, request)).toEqual(
      readAgentSessionHistory(fixture.journal, request)
    )
  }
  const pool = new JournalSqlReaderPool(join(fixture.root, 'agent-session-journal.db'))
  try {
    const request = { sessionId: 'session-1', direction: 'tail', limit: 2 } as const
    expect(await Promise.all(Array.from({ length: 5 }, () => pool.read(request)))).toEqual(
      Array.from({ length: 5 }, () => readAgentSessionHistory(fixture.journal, request))
    )
  } finally {
    await pool.close()
  }
  await expect(pool.read({ sessionId: 'session-1', direction: 'tail' })).rejects.toThrow('closed')
})

it('keeps subagent sibling windows, producer scopes and off-page labels identical', async () => {
  await fixture.journal.appendItem(
    item(1),
    {
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: 'roster',
          agents: [{ id: 'child', label: 'Read files', state: 'completed' }]
        }
      ]
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await fixture.journal.appendItem(item(2), body('child output'), {
    fence: 1,
    turnScope: { kind: 'thread' },
    agentId: 'child'
  })
  for (let index = 3; index < 11; index++) {
    await fixture.journal.appendItem(
      item(index),
      index === 4 || index === 8
        ? {
            kind: 'message',
            role: 'system',
            blocks: [
              {
                type: 'subagent',
                groupId: 'siblings',
                id: `helper-${index}`,
                label: 'Read',
                state: 'completed'
              }
            ]
          }
        : body(`row ${index}`),
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  }
  await fixture.journal.appendLifecycleBatch({
    settlementId: 'siblings-at-one-sequence',
    fence: 1,
    mutations: [11, 12].map((ordinal) => ({
      kind: 'item' as const,
      identity: item(ordinal),
      body: body(`batch ${ordinal}`),
      turnScope: { kind: 'thread' as const }
    }))
  })
  const db = convert()
  const tail = readJournalSqlHistoryPage(db, {
    sessionId: 'session-1',
    direction: 'tail',
    limit: 1
  })
  expect(tail).toMatchObject({
    ok: true,
    page: {
      items: [
        expect.objectContaining({ body: body('batch 11') }),
        expect.objectContaining({ body: body('batch 12') })
      ]
    }
  })
  for (const scope of ['every-agent', 'own-agent'] as const) {
    for (const limit of [1, 2, 3, 20]) {
      const request = { sessionId: 'session-1', direction: 'tail', limit } as const
      expect(readJournalSqlHistoryPage(db, { ...request, scope })).toEqual(
        readAgentSessionHistory(fixture.journal, request, { scope })
      )
    }
  }
})

it('applies byte bounds to wire values without truncating stored bodies', async () => {
  await fixture.journal.appendItem(item(1), body('older'), {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  await fixture.journal.appendItem(item(2), body('x'.repeat(4000)), {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  await fixture.journal.appendItem(item(3), body('newer'), {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  const db = convert()
  const reader = { budgetBytes: 1024, form: measureHistoryItem }
  const request: AgentSessionHistoryRequest = { sessionId: 'session-1', direction: 'tail' }
  expect(readJournalSqlHistoryPage(db, { ...request, direction: 'tail' }, reader)).toEqual(
    readAgentSessionHistory(fixture.journal, request, { reader })
  )
  const before = {
    ...request,
    direction: 'before',
    cursor: { epoch: fixture.journal.epoch, sequence: 4 }
  } as const
  expect(readJournalSqlHistoryPage(db, before, reader)).toEqual(
    readAgentSessionHistory(fixture.journal, before, { reader })
  )
  expect(fixture.journal.snapshot().items[1]!.body).toEqual(body('x'.repeat(4000)))
})

it.each([
  { name: 'lifecycle', rows: journalSqlLifecycleRows() },
  { name: 'native retry', rows: journalSqlRetryRows(false) },
  { name: 'legacy retry', rows: journalSqlRetryRows(true) }
])('matches memory pages for the existing $name fixture', ({ rows }) => {
  const database = openTestJournalHostDatabase(fixture.root)
  database.transaction((db) => {
    publishTestJournalEpoch(db, 'session', 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', rows).adopt()
    convertJournalSqlProjection(db, 'session')
  })
  const snapshot = renderJournalState(restoreJournal(database.db, 'session')!.state)
  for (const limit of [1, 2, 40]) {
    const request = { sessionId: 'session', direction: 'tail', limit } as const
    const actual = readJournalSqlHistoryPage(database.db, request)
    expect(actual).toEqual(readAgentSessionHistory(fixture.journal, request, { snapshot }))
    if (!actual.ok) {
      throw new Error('expected page')
    }
    const before = {
      ...request,
      direction: 'before',
      cursor: actual.page.window.nextCursor
    } as const
    expect(readJournalSqlHistoryPage(database.db, before)).toEqual(
      readAgentSessionHistory(fixture.journal, before, { snapshot })
    )
  }
})

it('answers that a chat is converting instead of serving its partly written rows', async () => {
  await appendItems(3)
  const db = convert()
  db.prepare(`UPDATE journal_proj_meta SET state='converting'`).run()
  expect(() =>
    readJournalSqlHistoryPage(db, { sessionId: 'session-1', direction: 'tail' })
  ).toThrow(JournalProjectionStaleError)
})
