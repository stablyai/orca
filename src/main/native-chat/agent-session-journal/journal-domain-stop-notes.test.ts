import { afterEach, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { openJournalDatabase, runJournalTransaction } from './database/journal-database'
import { applyJournalDomainItem } from './journal-domain-item'
import {
  insertJournalDomainImportPage,
  finishJournalDomainImport
} from './journal-domain-import-rows'
import { readJournalDomainHistoryPage } from './journal-domain-history-page'
import { measureHistoryItem } from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { prepareJournalDomainImport } from './journal-domain-import'
import { publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { publishJournalOutcomeEpoch } from './outcomes/journal-outcome-epoch.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import type { JournalRow } from './durable-rows/journal-row-schema'
import { messageFixture, target } from './journal-sql-message.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { removeJournalDomainItem } from './journal-domain-item-removal'
import { refreshJournalDomainStopNotes } from './journal-domain-stop-notes'

const close: (() => void)[] = []
afterEach(() => close.splice(0).forEach((fn) => fn()))
const noteId = 'orca:stop%3Aturn-1'
const turnId = 'orca:turn-1'
const original: AgentJournalItemBody = JSON.parse(`{
  "kind":"status","text":"Saved older cancellation failure.","tone":"error",
  "failure":{"kind":"cancelUnconfirmed","detail":{"text":"Exact saved detail.","audience":"person"}}
}`)

function fixture() {
  const value = messageFixture()
  close.push(() => value.db.close())
  const write = (clientMessageId: string, body: AgentJournalItemBody, turnItemId?: string) =>
    runJournalTransaction(value.db, () =>
      applyJournalDomainItem(
        value.db,
        target,
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId },
          body,
          options: {
            fence: 1,
            observedAt: 20,
            turnScope: turnItemId ? { kind: 'turn', turnItemId } : { kind: 'thread' }
          }
        },
        100
      )
    )
  const turn = (state: 'running' | 'interrupted' | 'completed') =>
    write('turn-1', { kind: 'turn', turnId: 'turn-1', state })
  const display = () =>
    readJournalSqlPoint(value.db, {
      sessionId: 'chat',
      operation: { kind: 'item-detail', itemId: noteId }
    })
  return { ...value, write, turn, display }
}

it('commits Stop display with the turn at its original revision and restores the exact source', () => {
  const { db, item, write, turn, display } = fixture()
  turn('running')
  const noted = write('stop:turn-1', original, turnId)
  expect(noted.items[0]!.body).toEqual(original)
  for (const id of ['large-1', 'large-2']) {
    write(id, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'x'.repeat(650) }]
    })
  }
  const stopped = turn('interrupted')
  expect(stopped.items.map((value) => value.itemId)).toEqual([turnId, noteId])
  expect(item(noteId)).toMatchObject({ revision: 1, sequence: 12, observedAt: 20, body: original })
  expect(display()).toMatchObject({
    item: {
      revision: 1,
      sequence: 12,
      observedAt: 20,
      body: { kind: 'status', text: 'Cancellation requested.' }
    }
  })
  const context = new JournalSqlStatusContext(new JournalSqlScope(db, 'chat', 'epoch'))
  expect(context.item(noteId)?.body).toEqual(original)
  expect(context.displayed(noteId)?.body).toEqual({
    kind: 'status',
    text: 'Cancellation requested.'
  })
  expect(
    readJournalSqlPoint(db, {
      sessionId: 'chat',
      operation: {
        kind: 'fork-marker-group',
        boundary: { kind: 'item', itemId: noteId }
      }
    })
  ).toMatchObject({
    snapshot: {
      items: [
        { itemId: noteId, revision: 1, body: { kind: 'status', text: 'Cancellation requested.' } }
      ]
    }
  })
  expect(
    readJournalSqlPoint(db, {
      sessionId: 'chat',
      operation: { kind: 'projected-stop-notes', afterOrdinal: -1, limit: 128 }
    })
  ).toMatchObject({ kind: 'projected-stop-notes', items: [{ itemId: noteId }], nextOrdinal: null })
  const seen: string[] = []
  const cursors: number[] = []
  let cursor = noted.cursor
  for (;;) {
    const page = readJournalDomainHistoryPage(
      db,
      {
        sessionId: target.sessionId,
        direction: 'after',
        cursor,
        limit: 3
      },
      { form: measureHistoryItem, budgetBytes: 1024 }
    )
    expect(page.ok).toBe(true)
    seen.push(...page.page.items.map((value) => value.itemId))
    cursor = page.page.window.nextCursor
    cursors.push(cursor.sequence)
    if (!page.page.hasNewer) {
      break
    }
  }
  expect(cursors).toEqual([13, 14, 15])
  expect(seen).toEqual(['orca:large-1', 'orca:large-2', turnId, noteId])
  expect(turn('interrupted').items.map((value) => value.itemId)).toEqual([turnId])
  expect(turn('completed').items.at(-1)!.body).toEqual(original)
  expect(
    readJournalSqlPoint(db, {
      sessionId: 'chat',
      operation: { kind: 'projected-stop-notes', afterOrdinal: -1, limit: 128 }
    })
  ).toMatchObject({ kind: 'projected-stop-notes', items: [], nextOrdinal: null })
  expect(item(noteId)).toMatchObject({ revision: 1, sequence: 12, observedAt: 20, body: original })
  write('stop:turn-1', { kind: 'status', text: 'Confirmed.' }, turnId)
  expect(
    db
      .prepare('SELECT turn_item_id,original_stop_note_json FROM journal_items WHERE item_id=?')
      .get(noteId)
  ).toEqual({ turn_item_id: turnId, original_stop_note_json: null })
  expect(turn('interrupted').items.map((value) => value.itemId)).toEqual([turnId])
})

it('rolls back both the changed turn and its Stop revision when the derived write fails', () => {
  const { db, item, write, turn, display } = fixture()
  turn('interrupted')
  expect(write('stop:turn-1', original, turnId).items[0]!.body).toEqual({
    kind: 'status',
    text: 'Cancellation requested.'
  })
  const before = db
    .prepare('SELECT sequence,changes_json FROM journal_events ORDER BY sequence')
    .all()
  db.exec(`CREATE TRIGGER reject_stop_revision BEFORE UPDATE ON journal_items
    WHEN NEW.item_id='orca:stop%3Aturn-1' BEGIN SELECT RAISE(ABORT, 'stop revision failed'); END`)
  expect(() => turn('completed')).toThrow('stop revision failed')
  expect(item(turnId)!.body).toEqual({ kind: 'turn', turnId: 'turn-1', state: 'interrupted' })
  expect(item(noteId)).toMatchObject({ revision: 1, body: original })
  expect(display()).toMatchObject({
    item: { revision: 1, body: { kind: 'status', text: 'Cancellation requested.' } }
  })
  expect(
    db.prepare('SELECT sequence,changes_json FROM journal_events ORDER BY sequence').all()
  ).toEqual(before)
})

it('keeps full semantic source when an unprojected Stop has a shortened wire head and restores it on removal', () => {
  const { db, item, write, turn, display } = fixture()
  const large: AgentJournalItemBody = JSON.parse(`{
    "kind":"status","text":"${'x'.repeat(2_097_152)}","failure":{"kind":"cancelUnconfirmed"}
  }`)
  turn('running')
  write('stop:turn-1', large, turnId)
  const context = () => new JournalSqlStatusContext(new JournalSqlScope(db, 'chat', 'epoch'))
  expect(context().displayed(noteId)?.body).toEqual(large)
  expect(display()).toMatchObject({ item: { body: large } })
  expect(turn('running').items.map((value) => value.itemId)).toEqual([turnId])
  turn('interrupted')
  const revised: AgentJournalItemBody = JSON.parse(`{
    "kind":"status","text":"New source failure.","failure":{"kind":"cancelUnconfirmed"}
  }`)
  expect(write('stop:turn-1', revised, turnId).items[0]).toMatchObject({
    revision: 2,
    body: { kind: 'status', text: 'Cancellation requested.' }
  })
  expect(item(noteId)).toMatchObject({ revision: 2, body: revised })
  const removed = runJournalTransaction(db, () => removeJournalDomainItem(db, target, turnId, 100))
  expect(removed.items).toMatchObject([{ itemId: noteId, revision: 2, body: revised }])
  expect(display()).toMatchObject({ item: { revision: 2, body: revised } })
})

it('imports an already interrupted Stop from the complete raw source even when its note page precedes its turn', () => {
  const { db, item, display } = fixture()
  db.exec('DELETE FROM journal_chat_state')
  const { db: source } = openJournalDatabase(':memory:')
  close.push(() => source.close())
  const epoch = journalSqlRetryRows(false)[0]!
  const base = { v: epoch.v, epoch: 'epoch', ts: 100, fence: 1 }
  const rows: JournalRow[] = [
    { ...epoch, seq: 1 },
    {
      ...base,
      kind: 'item',
      seq: 2,
      itemId: noteId,
      revision: 4,
      body: original,
      turnScope: { kind: 'turn', turnItemId: turnId }
    },
    {
      ...base,
      kind: 'item',
      seq: 3,
      itemId: turnId,
      revision: 3,
      body: { kind: 'turn', turnId: 'turn-1', state: 'interrupted' }
    }
  ]
  runJournalTransaction(source, () => {
    publishJournalSessionEpoch(source, { sessionId: 'chat', workspaceId: 'workspace' }, 'epoch')
    publishJournalOutcomeEpoch(source, 'chat', 'epoch', rows)
  })
  const { pages, ...header } = prepareJournalDomainImport(source, 'chat')!
  for (const page of pages) {
    runJournalTransaction(db, () => {
      if (page.kind === 'items') {
        for (const row of page.rows) {
          insertJournalDomainImportPage(db, target, { kind: 'items', rows: [row] })
        }
      } else {
        insertJournalDomainImportPage(db, target, page)
      }
    })
  }
  runJournalTransaction(db, () => finishJournalDomainImport(db, header))
  expect(item(noteId)).toMatchObject({ revision: 4, sequence: 2, body: original })
  expect(display()).toMatchObject({
    item: { revision: 4, sequence: 2, body: { kind: 'status', text: 'Cancellation requested.' } }
  })
  expect(
    db
      .prepare('SELECT turn_item_id,original_stop_note_json FROM journal_items WHERE item_id=?')
      .get(noteId)
  ).toEqual({ turn_item_id: turnId, original_stop_note_json: JSON.stringify(original) })
})

it('derives a stale Stop presentation from its owning turn before history admission', () => {
  const { db, write, turn, display, item } = fixture()
  turn('interrupted')
  write('stop:turn-1', original, turnId)
  db.prepare(`UPDATE journal_items SET wire_version=NULL,wire_bytes=99999999,
    wire_json=payload_json,detail_json=payload_json WHERE item_id=?`).run(noteId)
  expect(display()).toMatchObject({
    item: { body: { kind: 'status', text: 'Cancellation requested.' } }
  })
  for (const queuedImages of [undefined, { ids: [], imageIds: [] }]) {
    expect(
      readJournalDomainHistoryPage(db, {
        sessionId: 'chat',
        direction: 'tail',
        reader: { form: 'client', budgetBytes: 1024, queuedImages }
      }).page.items
    ).toContainEqual(
      expect.objectContaining({
        itemId: noteId,
        body: { kind: 'status', text: 'Cancellation requested.' }
      })
    )
  }
  const context = new JournalSqlStatusContext(new JournalSqlScope(db, 'chat', 'epoch'))
  expect(context.displayed(noteId)?.body).toEqual({
    kind: 'status',
    text: 'Cancellation requested.'
  })
  expect(
    readJournalSqlPoint(db, {
      sessionId: 'chat',
      operation: { kind: 'projected-stop-notes', afterOrdinal: -1, limit: 128 }
    })
  ).toMatchObject({
    items: [{ itemId: noteId, body: { kind: 'status', text: 'Cancellation requested.' } }]
  })
  expect(
    readJournalSqlPoint(db, {
      sessionId: 'chat',
      operation: { kind: 'fork-marker-group', boundary: { kind: 'item', itemId: noteId } }
    })
  ).toMatchObject({
    snapshot: {
      items: [{ itemId: noteId, body: { kind: 'status', text: 'Cancellation requested.' } }]
    }
  })
  expect(item(noteId)?.body).toEqual(original)
  // An ordinary owning-turn refresh repairs the stamp even when its displayed body is equal.
  expect(
    runJournalTransaction(db, () => refreshJournalDomainStopNotes(db, target, [turnId]))
  ).toEqual([])
  expect(db.prepare('SELECT wire_version FROM journal_items WHERE item_id=?').get(noteId)).toEqual({
    wire_version: 1
  })
  expect(display()).toMatchObject({
    item: { body: { kind: 'status', text: 'Cancellation requested.' } }
  })
})
