import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { readAgentSessionHistory } from '../agent-session-wire/agent-session-history-page'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { readJournalOutcomeGroups } from './journal-read-row'
import { journalOutcomeSource } from './journal-outcome-format'
import {
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionBase as base,
  seedOutcomeRows
} from './journal-projection-test-support'
import type { JournalRow } from './journal-row-schema'

const journals = createTrackedJournalOpener()
let root: string
const identity = {
  sessionId,
  workspaceId: 'ws',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
} as const
const item = (id: string) => ({ provider: 'orca', clientMessageId: id }) as const
afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps sparse sequence groups whole across catch-up, lookahead, history limits and byte shrinking', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcomes-wire-'))
  const database = openTestJournalHostDatabase(root)
  const rows: JournalRow[] = [projectionEpochRow]
  for (let seq = 2; seq <= 30; seq++) {
    rows.push({
      ...base(seq),
      kind: 'item',
      itemId: 'legacy',
      revision: seq,
      body: { kind: 'status', text: `revision ${seq}` }
    })
  }
  seedOutcomeRows(database, rows)
  const journal = await journals.open({ identity, stateDirectory: root })
  const before = { epoch, sequence: 1 }
  const old = journal.readSince(before)
  if (!old.ok) {
    throw new Error('dense read failed')
  }
  const expected = projectJournalBatch({
    rows: old.rows,
    snapshot: journal.snapshot(),
    afterSequence: 1
  })
  // Retention keeps a key's first and latest records, leaving whole sequences without any.
  database.db.prepare('DELETE FROM journal_outcomes WHERE seq BETWEEN 3 AND 29').run()
  const source = journalOutcomeSource(database.db, sessionId, epoch)
  if (!source) {
    throw new Error('missing outcome records')
  }
  const sparse = readJournalOutcomeGroups(database.db, epoch, source, 1)
  expect(sparse.length).toBeLessThan(old.rows.length)
  expect(
    projectJournalBatch({ rows: sparse, snapshot: journal.snapshot(), afterSequence: 1 })
  ).toEqual(expected)
  const cursor = journal.cursor()
  await journal.appendLifecycleBatch({
    settlementId: 'whole-group',
    fence: 1,
    mutations: ['one', 'two'].map((id) => ({
      kind: 'item',
      identity: item(id),
      body: { kind: 'status', text: id },
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
  })
  await journal.appendItem(
    item('later'),
    { kind: 'status', text: 'later' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const first = readAgentSessionHistory(journal, {
    sessionId,
    direction: 'after',
    cursor,
    limit: 1
  })
  expect(first).toMatchObject({
    ok: true,
    page: {
      hasNewer: true,
      items: [{ body: { text: 'one' } }, { body: { text: 'two' } }],
      window: { nextCursor: { sequence: cursor.sequence + 1 } }
    }
  })
  if (!first.ok) {
    throw new Error('first group missing')
  }
  const second = readAgentSessionHistory(journal, {
    sessionId,
    direction: 'after',
    cursor: first.page.window.nextCursor,
    limit: 1
  })
  expect(second).toMatchObject({
    ok: true,
    page: { hasNewer: false, items: [{ body: { text: 'later' } }] }
  })
  const bounded = readAgentSessionHistory(
    journal,
    { sessionId, direction: 'after', cursor, limit: 5 },
    { reader: { budgetBytes: 1, form: (value) => ({ item: value, bytes: 100 }) } }
  )
  expect(bounded).toMatchObject({ ok: false, reset: 'cursor_compacted' })
})
