import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { journalDatabaseFile } from '../agent-session-journal/journal-paths'
import {
  insertJournalRow,
  upsertJournalSessionRow
} from '../agent-session-journal/journal-row-table'
import * as journalReducer from '../agent-session-journal/journal-reducer'
import * as rowSchema from '../agent-session-journal/journal-row-schema'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { readAgentSessionHistory } from './agent-session-history-page'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'bounded-catch-up',
  workspaceId: 'folder-workspace',
  hostId: 'remote-host',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const journals = createTrackedJournalOpener()
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

async function seedJournal(count: number) {
  root = await mkdtemp(join(tmpdir(), 'orca-history-read-budget-'))
  const { db } = openJournalDatabase(journalDatabaseFile(root))
  const base = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-1',
    fence: 1,
    ts: 1_000
  }
  try {
    db.exec('BEGIN IMMEDIATE')
    upsertJournalSessionRow(db, identity.sessionId, base.epoch, base.ts)
    insertJournalRow(db, identity.sessionId, {
      ...base,
      kind: 'epoch',
      seq: 1,
      reason: 'session_created',
      providerHandle: identity.providerHandle
    })
    for (let index = 0; index < count; index += 1) {
      insertJournalRow(db, identity.sessionId, {
        ...base,
        kind: 'item',
        seq: index + 2,
        itemId: `item-${index}`,
        revision: 1,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `${index}:${'x'.repeat(4096)}` }]
        }
      })
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  return journals.open({ identity, journalDir: root })
}

function observeForwardReads() {
  const returnedRows: number[] = []
  const observed = new WeakSet<object>()
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database, sql) {
    const statement = prepare.call(this, sql)
    if (sql.includes('seq > ?') && !observed.has(statement)) {
      observed.add(statement)
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        const rows = all(...args)
        returnedRows.push(rows.length)
        return rows
      })
    }
    return statement
  })
  const parse = vi.spyOn(rowSchema, 'parseJournalRow')
  return { returnedRows, parse }
}

describe('forward history SQL read budget', () => {
  it('reconnects through every page with one lookahead row per page', async () => {
    const count = 2_000
    const journal = await seedJournal(count)
    const { returnedRows, parse } = observeForwardReads()
    const events: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers().open({
      id: 'reader',
      sessionId: identity.sessionId,
      journal,
      fence: 1,
      cursor: { epoch: journal.epoch, sequence: 1 },
      emit: (event) => events.push(event)
    })
    const batches = events.filter((event) => event.type === 'batch')
    expect(batches.flatMap((event) => event.batch.items.map((item) => item.itemId))).toEqual(
      Array.from({ length: count }, (_, index) => `item-${index}`)
    )
    expect(batches.at(-1)?.batch.cursor).toEqual(journal.cursor())
    expect(returnedRows).toEqual([...Array<number>(9).fill(201), 200])
    expect(parse).toHaveBeenCalledTimes(2_009)
  })

  it('reduces the timeline once for the whole catch-up, not once per page', async () => {
    const journal = await seedJournal(2_000)
    const render = vi.spyOn(journalReducer, 'renderJournalState')
    const events: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers().open({
      id: 'reader',
      sessionId: identity.sessionId,
      journal,
      fence: 1,
      cursor: { epoch: journal.epoch, sequence: 1 },
      emit: (event) => events.push(event)
    })
    // Catch-up is synchronous, so the reduced timeline cannot change between pages.
    expect(events.filter((event) => event.type === 'batch')).toHaveLength(10)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('keeps an exact final page final and preserves unlimited journal readers', async () => {
    const journal = await seedJournal(6)
    const cursor = { epoch: journal.epoch, sequence: 1 }
    expect(journal.readSince(cursor)).toMatchObject({ ok: true, rows: expect.any(Array) })
    const first = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor,
      limit: 3
    })
    expect(first).toMatchObject({ ok: true, page: { hasNewer: true } })
    if (!first.ok) {
      throw new Error('Expected first page')
    }
    const last = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor: first.page.window.nextCursor,
      limit: 3
    })
    expect(last).toMatchObject({ ok: true, page: { hasNewer: false } })
    const unlimited = journal.readSince(cursor)
    expect(unlimited.ok && unlimited.rows).toHaveLength(6)
  })

  it('reports a sequence gap when the next page reaches it', async () => {
    const journal = await seedJournal(6)
    const { db } = openJournalDatabase(journalDatabaseFile(root!))
    try {
      db.prepare('DELETE FROM journal_rows WHERE session_id = ? AND seq = ?').run(
        identity.sessionId,
        4
      )
    } finally {
      db.close()
    }
    const first = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor: { epoch: journal.epoch, sequence: 1 },
      limit: 2
    })
    expect(first).toMatchObject({ ok: true, page: { hasNewer: true } })
    if (!first.ok) {
      throw new Error('Expected first page')
    }
    expect(
      readAgentSessionHistory(journal, {
        sessionId: identity.sessionId,
        direction: 'after',
        cursor: first.page.window.nextCursor,
        limit: 2
      })
    ).toMatchObject({ ok: false, reset: 'journal_gap' })
  })

  it.each(['{', '{"v":9999}'])(
    'preserves parse-stop behavior at lookahead: %s',
    async (rowJson) => {
      const journal = await seedJournal(6)
      const { db } = openJournalDatabase(journalDatabaseFile(root!))
      try {
        db.prepare('UPDATE journal_rows SET row_json = ? WHERE session_id = ? AND seq = ?').run(
          rowJson,
          identity.sessionId,
          4
        )
      } finally {
        db.close()
      }
      const page = readAgentSessionHistory(journal, {
        sessionId: identity.sessionId,
        direction: 'after',
        cursor: { epoch: journal.epoch, sequence: 1 },
        limit: 2
      })
      expect(page).toMatchObject({
        ok: true,
        page: { hasNewer: false, window: { nextCursor: { sequence: 3 } } }
      })
      if (!page.ok) {
        throw new Error('Expected valid prefix')
      }
      expect(page.page.items.map((item) => item.itemId)).toEqual(['item-0', 'item-1'])
    }
  )
})
