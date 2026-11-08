import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { measureHistoryItem } from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { message, messageFixture, target } from './journal-sql-message.test-fixture'
import {
  readJournalDomainHistoryPage,
  type JournalDomainHistoryRequest
} from './journal-domain-history-page'
import { migrateJournalDomainSchema } from './journal-domain-schema'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const step of cleanup.splice(0)) {
    step()
  }
})

function history(db = new Database(':memory:')) {
  const value = messageFixture(db)
  cleanup.push(() => db.close())
  return {
    ...value,
    head: (sequence: number, retained = 0) =>
      db
        .prepare('UPDATE journal_chat_state SET last_sequence=?, retained_sequence=?')
        .run(sequence, retained),
    event: (sequence: number, itemIds: string[]) =>
      db.prepare('INSERT INTO journal_events VALUES(?,?,?,0,?)').run(
        target.sessionId,
        target.epoch,
        sequence,
        JSON.stringify({
          items: itemIds.map((itemId) => ({ itemId, revision: 1, sequence, sequenceIndex: 0 })),
          submissions: [],
          cards: []
        })
      ),
    read: (
      request: Omit<JournalDomainHistoryRequest, 'sessionId'>,
      reader?: Parameters<typeof readJournalDomainHistoryPage>[2]
    ) => readJournalDomainHistoryPage(db, { sessionId: target.sessionId, ...request }, reader)
  }
}

function text(
  sequence: number,
  value: string,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return {
    itemId: `orca:${sequence}:${extra.sequenceIndex ?? 0}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] },
    turnScope: { kind: 'thread' },
    ...extra
  }
}

const sequences = (result: AgentSessionHistoryResult) =>
  result.page.items.map((item) => item.sequence)

it('pages a chat of almost only subagent rows in bounded, gap-free pages', () => {
  const { seedItem, head, read } = history()
  seedItem({
    ...text(1, ''),
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'subagent', id: 'child', label: 'Child', state: 'working', groupId: 'g' }]
    }
  })
  for (let sequence = 2; sequence <= 301; sequence++) {
    seedItem(text(sequence, 'child work', { agentId: 'child' }))
  }
  head(301)
  let result = read({ direction: 'tail', limit: 40 })
  expect(result.page.subagentRoster).toMatchObject([
    { itemId: 'orca:1:0', sequence: 1, entry: { id: 'child', label: 'Child' } }
  ])
  const sizes: number[] = []
  const seen: number[] = []
  for (;;) {
    expect(result.ok).toBe(true)
    sizes.push(result.page.items.length)
    seen.unshift(...sequences(result))
    if (!result.page.hasOlder) {
      break
    }
    result = read({ direction: 'before', cursor: result.page.window.nextCursor, limit: 40 })
  }
  expect(sizes).toEqual([80, 80, 80, 61])
  expect(seen).toEqual(Array.from({ length: 301 }, (_, index) => index + 1))
})

it('never splits a same-sequence group, marking it oversized backward and paging it whole forward', () => {
  const { seedItem, head, event, read } = history()
  const group = Array.from({ length: 100 }, (_, index) =>
    text(50, 'x'.repeat(1000), { sequenceIndex: index })
  )
  seedItem(text(49, 'before'))
  event(49, ['orca:49:0'])
  for (const item of group) {
    seedItem(item)
  }
  event(
    50,
    group.map((item) => item.itemId)
  )
  for (let sequence = 51; sequence <= 60; sequence++) {
    seedItem(text(sequence, 'after'))
    event(sequence, [`orca:${sequence}:0`])
  }
  head(60, 48)
  const small = { form: measureHistoryItem, budgetBytes: 50_000 }
  const tail = read({ direction: 'tail', limit: 40 }, small)
  expect(sequences(tail)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60])
  const wide = read({ direction: 'before', cursor: tail.page.window.nextCursor, limit: 40 }, small)
  expect(wide.page.items.map((item) => item.itemId)).toEqual(group.map((item) => item.itemId))
  expect(new Set(wide.page.items.map((item) => item.body.kind))).toEqual(new Set(['status']))
  expect(wide.page).toMatchObject({ hasOlder: true, window: { nextCursor: { sequence: 50 } } })
  const rest = read({ direction: 'before', cursor: wide.page.window.nextCursor, limit: 40 }, small)
  expect(sequences(rest)).toEqual([49])
  expect(rest.page.hasOlder).toBe(false)

  const forward: string[] = []
  let cursor = { epoch: 'epoch', sequence: 48 }
  for (const expected of [true, true, false]) {
    const page = read({ direction: 'after', cursor, limit: 4 })
    expect(page).toMatchObject({ ok: true, page: { hasNewer: expected } })
    forward.push(...page.page.items.map((item) => item.itemId))
    cursor = page.page.window.nextCursor
  }
  expect(cursor.sequence).toBe(60)
  expect(forward).toEqual([
    'orca:49:0',
    ...group.map((item) => item.itemId),
    ...Array.from({ length: 10 }, (_, index) => `orca:${51 + index}:0`)
  ])
})

it('catches up with the current revision, placement and submission, not the replayed metadata', async () => {
  const { db, commit, seedSend, read } = history()
  seedSend()
  db.exec(`INSERT INTO journal_submission_attempts
    SELECT session_id,epoch,message_id,0,0,0,item_id,0,0,NULL,fingerprint,'unknown',0,NULL,NULL,'{}'
    FROM journal_submission_attempts WHERE current=1`)
  await commit(message('first'))
  await commit(message('second'))
  const echo = message('original', 'unused', 'item')
  echo.identity = { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 }
  echo.body.role = 'user'
  await commit(echo)
  const result = read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 10 } })
  expect(result).toMatchObject({
    ok: true,
    page: {
      items: [
        { itemId: 'orca:send', sequence: 7, body: { blocks: [{ text: 'original' }] } },
        {
          itemId: 'orca:assistant',
          revision: 2,
          sequence: 11,
          body: { blocks: [{ text: 'second' }] }
        }
      ],
      submissions: [{ clientMessageId: 'send', dispatchState: 'accepted', acceptedSequence: 1 }],
      window: { nextCursor: { epoch: 'epoch', sequence: 13 } },
      hasNewer: false
    }
  })
  const child = message('child work', 'child', 'item')
  child.options.agentId = 'child'
  await commit(child)
  expect(
    read({ direction: 'tail', scope: 'own-agent' }).page.items.map((item) => item.itemId)
  ).toEqual(['orca:send', 'orca:assistant'])
  expect(read({ direction: 'tail' }).page.items.map((item) => item.itemId)).toEqual([
    'orca:send',
    'orca:assistant',
    'orca:child'
  ])
})

it('resets a cursor below the pruned boundary or across a gap, and resumes at the boundary', () => {
  const { db, seedItem, head, event, read } = history()
  for (let sequence = 1; sequence <= 3; sequence++) {
    seedItem(text(sequence, 'row'))
  }
  event(3, ['orca:3:0'])
  head(3, 2)
  expect(read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 1 } })).toMatchObject({
    ok: false,
    reset: 'cursor_compacted',
    page: { direction: 'tail', items: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }] }
  })
  const resumed = read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 2 } })
  expect(resumed.ok).toBe(true)
  expect(sequences(resumed)).toEqual([3])
  db.exec('DELETE FROM journal_events')
  expect(read({ direction: 'after', cursor: { epoch: 'epoch', sequence: 2 } })).toMatchObject({
    ok: false,
    reset: 'journal_gap'
  })
})

it('answers every selected read from the snapshot its head came from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-domain-history-'))
  const path = join(dir, 'chat.db')
  const writer = new Database(path)
  writer.pragma('journal_mode=WAL')
  const { seedItem, head } = history(writer)
  seedItem(text(1, 'first'))
  seedItem({
    itemId: 'orca:turn',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'turn', turnId: 'turn', state: 'running', startedAt: 2 },
    turnScope: { kind: 'thread' }
  })
  head(2)
  const reader = new Database(path, { readonly: true })
  cleanup.push(
    () => reader.close(),
    () => rmSync(dir, { recursive: true })
  )
  let wrote = false
  const result = readJournalDomainHistoryPage(
    reader,
    { sessionId: target.sessionId, direction: 'tail' },
    {
      budgetBytes: 1024 * 1024,
      form: (item) => {
        if (!wrote) {
          wrote = true
          writer.exec('DELETE FROM journal_items; UPDATE journal_chat_state SET last_sequence=9')
        }
        return measureHistoryItem(item)
      }
    }
  )
  expect(result).toMatchObject({
    ok: true,
    page: {
      items: [{ itemId: 'orca:1:0' }, { itemId: 'orca:turn' }],
      liveCursor: { epoch: 'epoch', sequence: 2 },
      latestTurn: { itemId: 'orca:turn', turn: { state: 'running' } },
      hasOlder: false
    }
  })
  expect(writer.prepare('SELECT COUNT(*) AS count FROM journal_items').get()!.count).toBe(0)
})

it('backfills history metadata once from saved v1 rows and refuses a newer domain schema', () => {
  const db = new Database(':memory:')
  cleanup.push(() => db.close())
  migrateJournalDomainSchema(db)
  db.exec(`DROP INDEX journal_items_root_position;
    DROP INDEX journal_items_turn_marker;
    DROP INDEX journal_items_named_subagents;
    ALTER TABLE journal_items DROP COLUMN hidden;
    ALTER TABLE journal_items DROP COLUMN root;
    ALTER TABLE journal_items DROP COLUMN subagent_row;
    ALTER TABLE journal_items DROP COLUMN subagent_group_key;
    ALTER TABLE journal_items DROP COLUMN named_subagent_ids;
    ALTER TABLE journal_items DROP COLUMN turn_marker;
    DROP TABLE journal_edit_leases;
    DROP INDEX journal_events_saved_at;
    DELETE FROM journal_domain_migrations WHERE version>=2`)
  const rows: AgentJournalRenderItem[] = [
    {
      ...text(1, ''),
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'subagent', id: 'child', label: 'Child', state: 'working', groupId: 'g' }]
      }
    },
    text(2, 'child work', { agentId: 'child' }),
    {
      itemId: 'orca:turn',
      revision: 3,
      sequence: 3,
      observedAt: 3,
      body: { kind: 'turn', turnId: 'turn', state: 'completed' },
      turnScope: { kind: 'thread' }
    }
  ]
  for (const item of rows) {
    db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,payload_json)
      VALUES('chat','epoch',?,?,?,?,0,1,?)`).run(
      item.itemId,
      item.sequence,
      item.revision,
      item.sequence,
      JSON.stringify(item)
    )
  }
  migrateJournalDomainSchema(db)
  expect(
    db
      .prepare(`SELECT item_id, revision, hidden, root, subagent_row, subagent_group_key,
        named_subagent_ids, turn_marker, payload_json FROM journal_items ORDER BY sequence`)
      .all()
  ).toEqual([
    {
      item_id: 'orca:1:0',
      revision: 1,
      hidden: 0,
      root: 1,
      subagent_row: 1,
      subagent_group_key: 'g',
      named_subagent_ids: '["child"]',
      turn_marker: 0,
      payload_json: JSON.stringify(rows[0])
    },
    {
      item_id: 'orca:2:0',
      revision: 1,
      hidden: 0,
      root: 0,
      subagent_row: 0,
      subagent_group_key: null,
      named_subagent_ids: null,
      turn_marker: 0,
      payload_json: JSON.stringify(rows[1])
    },
    {
      item_id: 'orca:turn',
      revision: 3,
      hidden: 0,
      root: 1,
      subagent_row: 0,
      subagent_group_key: null,
      named_subagent_ids: null,
      turn_marker: 1,
      payload_json: JSON.stringify(rows[2])
    }
  ])
  db.exec('INSERT INTO journal_domain_migrations(version) VALUES (4)')
  expect(() => migrateJournalDomainSchema(db)).toThrow(
    'journal domain schema is newer than this writer'
  )
})
