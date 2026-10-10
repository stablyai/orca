import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { ensureQueuedMessagesTable } from './queued-message-schema'
import { getQueuedMessage, insertQueuedMessage } from './queued-message-table'
import { updateQueuedMessageText } from './queued-message-text-update'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'

let db: Database.Database
const sessionId = 'folder-session'
const initial: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'base' }]
}
beforeEach(() => {
  db = new Database(':memory:')
  ensureQueuedMessagesTable(db)
})
afterEach(() => db.close())
function insert(body = initial, messageId = 'card') {
  return insertQueuedMessage(db, {
    sessionId,
    messageId,
    body,
    fingerprint: agentSessionSendBodyFingerprint(sessionId, body),
    hostInstance: 'remote-host',
    queuedAt: { epoch: 'epoch', sequence: 4 },
    now: 1,
    holdReason: 'send_failed'
  })
}
function update(text: string, fingerprint = agentSessionSendBodyFingerprint(sessionId, initial)) {
  return updateQueuedMessageText(db, sessionId, {
    messageId: 'card',
    expectedBodyFingerprint: fingerprint,
    text
  })
}

describe('atomic queued text update', () => {
  it('preserves identity, cursor, order, sender, kind, role, send mode and attachment order', () => {
    const body: AgentJournalMessageItem = {
      ...initial,
      sentAs: 'goal',
      from: { kind: 'agent', senders: [], orchestration: null },
      blocks: [
        { type: 'image-ref', path: 'before.png' },
        { type: 'text', text: 'one' },
        { type: 'image-ref', url: 'https://example.com/image.png' },
        { type: 'text', text: 'two' }
      ]
    }
    const before = insert(body)
    expect(update('edited', before.fingerprint).status).toBe('updated')
    const after = getQueuedMessage(db, sessionId, 'card')!
    expect(after).toEqual({
      ...before,
      body: {
        ...body,
        blocks: [body.blocks[0]!, { type: 'text', text: 'edited' }, body.blocks[2]!]
      },
      fingerprint: after.fingerprint
    })
    expect(after.fingerprint).toBe(agentSessionSendBodyFingerprint(sessionId, after.body))
  })
  it('saving the same text keeps several text blocks as they are', () => {
    const body: AgentJournalMessageItem = {
      ...initial,
      blocks: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' }
      ]
    }
    const before = insert(body)
    expect(update('one\ntwo', before.fingerprint).status).toBe('unchanged')
    expect(getQueuedMessage(db, sessionId, 'card')).toEqual(before)
  })
  it('retains returned-card refusal and failure hold rather than requeueing', () => {
    insert()
    db.prepare(
      "UPDATE queued_messages SET state = 'returned', returned_reason = 'refused', consumed_as = 'submission' WHERE message_id = 'card'"
    ).run()
    const before = getQueuedMessage(db, sessionId, 'card')!
    expect(update('edit').status).toBe('updated')
    expect(getQueuedMessage(db, sessionId, 'card')).toMatchObject({
      state: 'returned',
      returnedReason: before.returnedReason,
      consumedAs: before.consumedAs,
      holdReason: before.holdReason,
      position: before.position
    })
  })
  it('checks the resulting body before the expected base, making lost-answer retry safe', () => {
    insert()
    expect(update('edit').status).toBe('updated')
    expect(update('edit').status).toBe('unchanged')
    expect(update('other').status).toBe('changed')
  })
  it('accepts semantic A/B/A and preserves the latest host-owned sender', () => {
    insert()
    const base = agentSessionSendBodyFingerprint(sessionId, initial)
    update('B')
    const second = getQueuedMessage(db, sessionId, 'card')!
    update('base', second.fingerprint)
    const from: NonNullable<AgentJournalMessageItem['from']> = {
      kind: 'agent',
      senders: [],
      orchestration: null
    }
    const latestBody = { ...initial, from }
    db.prepare("UPDATE queued_messages SET body_json = ? WHERE message_id = 'card'").run(
      JSON.stringify(latestBody)
    )
    expect(agentSessionSendBodyFingerprint(sessionId, latestBody)).toBe(base)
    expect(update('C', base).status).toBe('updated')
    expect(getQueuedMessage(db, sessionId, 'card')?.body.from).toEqual(from)
  })
  it('refuses empty, oversized, command and unsupported bodies without modifying them', () => {
    insert()
    expect(update('  ').status).toBe('not-editable')
    expect(update('é'.repeat(MAX_PROMPT_BYTES)).status).toBe('not-editable')
    db.prepare('DELETE FROM queued_messages').run()
    const command = insert({ ...initial, command: { name: 'compact' } })
    expect(update('edit', command.fingerprint).status).toBe('not-editable')
    expect(getQueuedMessage(db, sessionId, 'card')).toEqual(command)
    db.prepare('DELETE FROM queued_messages').run()
    const unsupported = insert({
      ...initial,
      blocks: [{ type: 'tool-result', callId: 'tool', output: 'retained' }]
    })
    expect(update('edit', unsupported.fingerprint).status).toBe('not-editable')
    expect(getQueuedMessage(db, sessionId, 'card')).toEqual(unsupported)
  })
  it('allows empty text with a retained attachment, and inserts text before one with none', () => {
    const before = insert({
      ...initial,
      blocks: [
        { type: 'text', text: 'caption' },
        { type: 'image-ref', path: 'file.png' }
      ]
    })
    expect(update('', before.fingerprint).status).toBe('updated')
    expect(getQueuedMessage(db, sessionId, 'card')?.body.blocks).toEqual([
      { type: 'text', text: '' },
      { type: 'image-ref', path: 'file.png' }
    ])
    const imageOnly = insert(
      { ...initial, blocks: [{ type: 'image-ref', path: 'file.png' }] },
      'image'
    )
    expect(
      updateQueuedMessageText(db, sessionId, {
        messageId: 'image',
        expectedBodyFingerprint: imageOnly.fingerprint,
        text: 'added'
      }).status
    ).toBe('updated')
    expect(getQueuedMessage(db, sessionId, 'image')?.body.blocks).toEqual([
      { type: 'text', text: 'added' },
      { type: 'image-ref', path: 'file.png' }
    ])
  })
  it('a failed transaction rolls back body and fingerprint together', () => {
    const before = insert()
    db.exec('BEGIN IMMEDIATE')
    update('edit')
    db.exec('ROLLBACK')
    expect(getQueuedMessage(db, sessionId, 'card')).toEqual(before)
  })
  it('dispatch, withdrawal and a pruned tombstone all answer gone', () => {
    insert()
    db.prepare("UPDATE queued_messages SET state = 'dispatched' WHERE message_id = 'card'").run()
    expect(update('edit')).toMatchObject({ status: 'gone', disposition: 'dispatched' })
    db.prepare("UPDATE queued_messages SET state = 'withdrawn' WHERE message_id = 'card'").run()
    expect(update('edit')).toMatchObject({ status: 'gone', disposition: 'withdrawn' })
    db.prepare('DELETE FROM queued_messages').run()
    expect(update('edit')).toMatchObject({ status: 'gone', disposition: 'missing' })
  })
})
