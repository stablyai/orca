import { afterEach, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { runJournalTransaction } from './database/journal-database'
import { applyJournalDomainItem } from './journal-domain-item'
import { applyJournalDomainTombstone } from './journal-domain-item-removal'
import {
  applyJournalDomainContextCommand,
  type JournalDomainContextOperation
} from './journal-domain-context-command'
import { readJournalDomainQueueFailure } from './journal-domain-queue-failures'
import { messageFixture, target } from './journal-sql-message.test-fixture'

const close: (() => void)[] = []
afterEach(() => close.splice(0).forEach((fn) => fn()))

const say = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})

function fixture() {
  const value = messageFixture()
  close.push(() => value.db.close())
  const { db } = value
  const write = (clientMessageId: string, body: AgentJournalItemBody, turnItemId?: string) =>
    runJournalTransaction(db, () =>
      applyJournalDomainItem(
        db,
        target,
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId },
          body,
          options: {
            fence: 1,
            turnScope: turnItemId ? { kind: 'turn', turnItemId } : { kind: 'thread' }
          }
        },
        100
      )
    )
  const context = (operation: JournalDomainContextOperation) =>
    runJournalTransaction(db, () => applyJournalDomainContextCommand(db, target, operation, 200))
  const remove = (clientMessageId: string) =>
    runJournalTransaction(db, () =>
      applyJournalDomainTombstone(
        db,
        target,
        { kind: 'tombstone', identity: { provider: 'orca', clientMessageId }, fence: 1 },
        300
      )
    )
  const clear = () =>
    context({
      kind: 'context-clear',
      boundary: { operationId: 'clear-1', afterFence: 1, clearedAt: 150 }
    })
  const ids = () =>
    db
      .prepare('SELECT item_id FROM journal_items ORDER BY sequence, sequence_index, ordinal')
      .all()
      .map((row) => String(row.item_id))
  const one = (sql: string, ...args: string[]) => db.prepare(sql).get(...args)
  return { ...value, write, context, remove, clear, ids, one }
}

it('rewinds the suffix after its floor, keeping removed-turn membership and resurrecting replayed items', () => {
  const { db, write, context, clear, ids, one } = fixture()
  write('kept', say('before the clear'))
  const cleared = clear()
  write('turn-1', { kind: 'turn', turnId: 'turn-1', state: 'completed' })
  write('answer', say('stale answer'), 'orca:turn-1')
  const floor = { epoch: cleared.cursor.epoch, sequence: cleared.cursor.sequence }

  const rewound = context({
    kind: 'context-rewind',
    floor,
    fence: 1,
    items: [
      {
        identity: { provider: 'orca', clientMessageId: 'answer' },
        body: say('replayed answer'),
        ownerFence: 1
      }
    ]
  })

  expect(rewound.removedItemIds).toEqual(['orca:turn-1', 'orca:answer'])
  expect(rewound.removedTurnIds).toEqual(['turn-1'])
  expect(ids()).toEqual(['orca:kept', 'orca:context-clear%3Aclear-1', 'orca:answer'])
  // The replay outranks its own tombstone and is current and visible again.
  expect(one('SELECT revision, hidden FROM journal_items WHERE item_id=?', 'orca:answer')).toEqual({
    revision: 3,
    hidden: 0
  })
  expect(
    one('SELECT COUNT(*) AS n FROM journal_item_tombstones WHERE item_id=?', 'orca:answer')
  ).toEqual({ n: 0 })
  expect(
    one('SELECT revision FROM journal_item_tombstones WHERE item_id=?', 'orca:turn-1')
  ).toEqual({ revision: 2 })
  expect(rewound.cursor).toEqual({ epoch: floor.epoch, sequence: rewound.physicalCursor.sequence })
  expect(rewound.clear).toMatchObject({ operationId: 'clear-1', lifted: true })

  // Removed-turn membership is independent of the item: reinserting the turn keeps it.
  write('turn-1', { kind: 'turn', turnId: 'turn-1', state: 'running' })
  expect(one('SELECT revision FROM journal_items WHERE item_id=?', 'orca:turn-1')).toEqual({
    revision: 3
  })
  expect(db.prepare('SELECT turn_id FROM journal_removed_turns').all()).toEqual([
    { turn_id: 'turn-1' }
  ])

  // Replaying an item at or before the floor refuses before any write.
  expect(() =>
    context({
      kind: 'context-rewind',
      floor,
      fence: 1,
      items: [
        {
          identity: { provider: 'orca', clientMessageId: 'kept' },
          body: say('x'),
          ownerFence: 1
        }
      ]
    })
  ).toThrow('agent_session_rewind:proof-mismatch')
})

it('lifts and restores a command turn failure hold as its report is removed and reinserted', () => {
  const { write, remove, db } = fixture()
  write('command-turn:send-1', {
    kind: 'turn',
    turnId: 'compact:send-1',
    state: 'completed',
    outcome: 'failure'
  })
  const report = { kind: 'status', text: 'Agent failed.', tone: 'error' } as const
  write('report', report, 'orca:command-turn%3Asend-1')
  const held = readJournalDomainQueueFailure(db, target)
  expect(held).toBeGreaterThan(0)

  const removed = remove('report')
  expect(removed.removedItemIds).toEqual(['orca:report'])
  expect(readJournalDomainQueueFailure(db, target)).toBe(0)

  write('report', report, 'orca:command-turn%3Asend-1')
  expect(readJournalDomainQueueFailure(db, target)).toBeGreaterThan(0)
})

it('rolls back an epoch replacement completely when one replacement write fails', () => {
  const { db, write, context, ids, one } = fixture()
  write('old', say('old history'))
  const before = {
    head: one(
      'SELECT last_sequence, context_boundary, derived_turn_item_id FROM journal_chat_state'
    ),
    events: db.prepare('SELECT sequence FROM journal_events ORDER BY sequence').all(),
    tombstones: db.prepare('SELECT * FROM journal_item_tombstones').all()
  }
  db.exec(`CREATE TRIGGER reject_replacement BEFORE INSERT ON journal_items
    WHEN NEW.item_id='orca:bad' BEGIN SELECT RAISE(ABORT, 'replacement failed'); END`)
  const replace = (clientMessageIds: string[]) =>
    context({
      kind: 'epoch-replace',
      reason: 'legacy_import',
      providerHandle: { kind: 'codex', threadId: 'conversation' },
      fence: 1,
      items: clientMessageIds.map((clientMessageId) => ({
        identity: { provider: 'orca', clientMessageId },
        body: say(clientMessageId),
        ownerFence: 1
      }))
    })

  expect(() => replace(['good', 'bad'])).toThrow('replacement failed')
  expect(ids()).toEqual(['orca:old'])
  expect(
    one('SELECT last_sequence, context_boundary, derived_turn_item_id FROM journal_chat_state')
  ).toEqual(before.head)
  expect(db.prepare('SELECT sequence FROM journal_events ORDER BY sequence').all()).toEqual(
    before.events
  )
  expect(db.prepare('SELECT * FROM journal_item_tombstones').all()).toEqual(before.tombstones)

  const replaced = replace(['good'])
  expect(ids()).toEqual(['orca:good'])
  expect(replaced.contextBoundary).toBe(replaced.physicalCursor.sequence - 1)
  expect(replaced.cursor.epoch).not.toBe(target.epoch)
  expect(one('SELECT epoch, context_boundary FROM journal_chat_state')).toEqual({
    epoch: target.epoch,
    context_boundary: replaced.contextBoundary
  })
})
