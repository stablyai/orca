import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  ensureAgentSessionAttachmentClaimTables,
  isAgentSessionAttachmentExpiredError,
  markUnclaimedUploadForSweep
} from '../agent-session-attachments/agent-session-attachment-claims'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainEditLease } from './journal-domain-edit-leases'
import {
  applyJournalDomainQueueCommand,
  type JournalDomainQueueOperation
} from './journal-domain-queue-command'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

const target = { sessionId: 'chat', epoch: 'epoch' }
const now = 1_800_000_000_000
const UPLOAD_A = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
const UPLOAD_B = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'
const cleanups: (() => void)[] = []

const text = (value: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: value }]
})

function fixture() {
  const db = new Database(':memory:')
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-domain-queue-'))
  cleanups.push(() => {
    db.close()
    rmSync(stateDirectory, { recursive: true, force: true })
  })
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,epoch,last_sequence,highest_fence)
    VALUES('chat','epoch',10,1)`).run()
  const seed = (
    messageId: string,
    position: number,
    fields: Partial<QueuedMessageRow> = {},
    version = 1
  ) => {
    const card = {
      messageId,
      position,
      body: text(messageId),
      state: 'waiting',
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null,
      queuedAt: { epoch: 'epoch', sequence: 1 },
      ...fields
    }
    db.prepare(`INSERT INTO journal_card_versions(session_id,epoch,message_id,version_sequence,
      version_index,current,state,payload_json,position) VALUES('chat','epoch',?,?,0,1,?,?,?)`).run(
      messageId,
      version,
      card.state,
      JSON.stringify(card),
      position
    )
  }
  const run = (operation: JournalDomainQueueOperation) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const commit = applyJournalDomainQueueCommand(db, stateDirectory, target, operation, now)
      db.exec('COMMIT')
      return commit
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const lease = (messageId: string, body = text(messageId)) => {
    db.exec('BEGIN IMMEDIATE')
    applyJournalDomainEditLease(
      db,
      target,
      'handle',
      {
        kind: 'acquire',
        callerKey: 'desktop',
        editId: `edit-${messageId}`,
        messageId,
        fingerprint: agentSessionSendBodyFingerprint('chat', body)
      },
      now
    )
    db.exec('COMMIT')
  }
  const leases = () =>
    db
      .prepare('SELECT message_id FROM journal_edit_leases ORDER BY message_id')
      .all()
      .map((row) => row.message_id)
  const head = () =>
    Number(db.prepare('SELECT last_sequence FROM journal_chat_state').get()!.last_sequence)
  const events = () =>
    db
      .prepare('SELECT sequence, changes_json FROM journal_events ORDER BY sequence')
      .all()
      .map((row) => [row.sequence, JSON.parse(String(row.changes_json)).cards])
  const versions = (messageId: string) =>
    db
      .prepare(`SELECT version_sequence, current, state, position, payload_json FROM journal_card_versions
        WHERE message_id=? ORDER BY version_sequence`)
      .all(messageId)
      .map((row) => {
        const payload = JSON.parse(String(row.payload_json))
        return [row.version_sequence, row.current, row.state, row.position, payload.body.blocks]
      })
  const order = () =>
    db
      .prepare(`SELECT message_id, position FROM journal_card_versions WHERE current=1
        ORDER BY position, message_id`)
      .all()
      .map((row) => [row.message_id, row.position])
  return { db, stateDirectory, seed, run, lease, leases, head, events, versions, order }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('admits a card once and keeps a replaced version only while an attempt names it', () => {
  const queue = fixture()
  queue.seed('earlier', 4, { state: 'withdrawn' })
  const first = queue.run({
    kind: 'queue-insert',
    input: { messageId: 'card', body: text('first'), deliveryMode: 'queue', unattended: false }
  })
  expect(first.cursor).toEqual({ epoch: 'epoch', sequence: 11 })
  expect(first.result).toMatchObject({
    kind: 'queue-insert',
    card: { position: 5, state: 'waiting', queuedAt: { epoch: 'epoch', sequence: 10 } }
  })
  const duplicate = queue.run({
    kind: 'queue-insert',
    input: { messageId: 'card', body: text('second') }
  })
  expect(duplicate).toMatchObject({
    cursor: { epoch: 'epoch', sequence: 11 },
    cards: [],
    inputChanged: false,
    result: { card: { body: text('first'), deliveryMode: 'queue', unattended: false } }
  })
  expect(queue.events()).toEqual([[11, ['card']]])

  queue.db
    .prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
    attempt_index,current,item_id,ordinal,submitted_at,fingerprint,dispatch_state,source_card_sequence,
    source_card_index,payload_json) VALUES('chat','epoch','send',12,0,1,'item',12,1,'f','pending',11,0,?)`)
    .run(JSON.stringify({ clientMessageId: 'send', queuedMessageId: 'card' }))
  const edit = (expected: string, value: string) =>
    queue.run({
      kind: 'queue-update',
      input: { messageId: 'card', expectedBodyFingerprint: expected, text: value }
    })
  edit(agentSessionSendBodyFingerprint('chat', text('first')), 'edited once')
  edit(agentSessionSendBodyFingerprint('chat', text('edited once')), 'edited twice')
  expect(queue.versions('card')).toEqual([
    [11, 0, 'waiting', 5, [{ type: 'text', text: 'first' }]],
    [13, 1, 'waiting', 5, [{ type: 'text', text: 'edited twice' }]]
  ])
})

it('answers a stale or repeated edit without a version and refuses a swept new upload atomically', () => {
  const queue = fixture()
  const root = agentSessionAttachmentStoreRoot(queue.stateDirectory)
  const image = (uploadId: string) => ({
    type: 'image-ref' as const,
    path: join(root, uploadId, 'shot.png')
  })
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'look' }, image(UPLOAD_A)]
  }
  queue.seed('card', 1, { body })
  queue.db.exec('BEGIN IMMEDIATE')
  markUnclaimedUploadForSweep(queue.db, UPLOAD_A, now)
  markUnclaimedUploadForSweep(queue.db, UPLOAD_B, now)
  queue.db.exec('COMMIT')
  const original = agentSessionSendBodyFingerprint('chat', body)
  const update = (expected: string, value: string, images?: ReturnType<typeof image>[]) =>
    queue.run({
      kind: 'queue-update',
      input: {
        messageId: 'card',
        expectedBodyFingerprint: expected,
        text: value,
        ...(images ? { images } : {})
      }
    })

  expect(update('someone-else', 'mine').result).toEqual({
    kind: 'queue-update',
    update: { status: 'changed', messageId: 'card' }
  })
  // The kept image is not newly referenced, so its sweep cannot block a text fix.
  const fixed = update(original, 'look again')
  expect(fixed.result).toMatchObject({ update: { status: 'updated' } })
  const edited = agentSessionSendBodyFingerprint('chat', {
    ...body,
    blocks: [{ type: 'text', text: 'look again' }, image(UPLOAD_A)]
  })
  // A lost reply retried with the old expectation reconciles to the applied edit.
  expect(update(original, 'look again').result).toEqual({
    kind: 'queue-update',
    update: { status: 'unchanged', messageId: 'card', fingerprint: edited }
  })
  expect(queue.head()).toBe(11)

  queue.lease('card', { ...body, blocks: [{ type: 'text', text: 'look again' }, image(UPLOAD_A)] })
  let refusal: unknown
  try {
    update(edited, 'with another', [image(UPLOAD_A), image(UPLOAD_B)])
  } catch (error) {
    refusal = error
  }
  expect(isAgentSessionAttachmentExpiredError(refusal)).toBe(true)
  expect(queue.head()).toBe(11)
  expect(queue.versions('card').filter(([, current]) => current === 1)).toEqual([
    [11, 1, 'waiting', 1, [{ type: 'text', text: 'look again' }, image(UPLOAD_A)]]
  ])
  expect(queue.leases()).toEqual(['card'])
  expect(queue.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()).toEqual([
    { upload_id: UPLOAD_A }
  ])
})

it('moves among unsettled cards only, keeping dispatched slots and id ties', () => {
  const queue = fixture()
  queue.seed('a', 1)
  queue.seed('b', 2, { state: 'dispatched', consumedAs: 'send-b' })
  queue.seed('c', 3, { state: 'returned', returnedReason: 'refused' })
  queue.seed('y', 4)
  queue.seed('x', 4)
  queue.lease('a')

  const moved = queue.run({
    kind: 'queue-move',
    input: { messageId: 'x', beforeMessageId: 'a' }
  })
  expect(moved.result).toEqual({ kind: 'queue-move', move: { messageId: 'x', status: 'moved' } })
  expect(queue.order()).toEqual([
    ['x', 1],
    ['b', 2],
    ['a', 3],
    ['c', 4],
    ['y', 4]
  ])
  expect(queue.events()).toEqual([[11, ['x', 'a', 'c']]])
  expect(queue.leases()).toEqual(['a'])
  expect(moved.editDeadline).toBeUndefined()

  const stale = queue.run({ kind: 'queue-move', input: { messageId: 'b', beforeMessageId: 'a' } })
  expect(stale.result).toEqual({ kind: 'queue-move', move: { messageId: 'b', status: 'gone' } })
  expect(queue.head()).toBe(11)
})

it('holds waiting cards and withdraws unsettled ones, ending only invalidated edit leases', () => {
  const queue = fixture()
  queue.seed('a', 1)
  queue.seed('b', 2, { state: 'dispatched', consumedAs: 'send-b' })
  queue.seed('c', 3, { state: 'returned' })
  queue.lease('a')
  queue.lease('c')

  const held = queue.run({ kind: 'queue-hold', messageIds: ['a', 'b', 'a'], reason: 'send_failed' })
  expect(held.cards.map((card) => [card.messageId, card.holdReason])).toEqual([
    ['a', 'send_failed']
  ])
  expect(queue.leases()).toEqual(['a', 'c'])
  const again = queue.run({ kind: 'queue-hold', messageIds: ['a'], reason: 'send_failed' })
  expect(again).toMatchObject({ cursor: { sequence: 11 }, cards: [], inputChanged: false })

  const withdrawn = queue.run({ kind: 'queue-withdraw', messageIds: ['b', 'c', 'missing'] })
  expect(withdrawn.result).toMatchObject({
    kind: 'queue-withdraw',
    cards: [{ messageId: 'c', state: 'withdrawn', holdReason: null }]
  })
  expect(withdrawn.editDeadline).toBe(now + 2 * 60_000)
  expect(queue.leases()).toEqual(['a'])
  expect(queue.events()).toEqual([
    [11, ['a']],
    [12, ['c']]
  ])
  expect(queue.versions('b')).toEqual([[1, 1, 'dispatched', 2, [{ type: 'text', text: 'b' }]]])
})
