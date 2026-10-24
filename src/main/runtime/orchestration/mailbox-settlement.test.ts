import { selectTerminalMailHandoff, terminalMailHandoffCanSubmit } from './terminal-mail-settlement'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { OrchestrationDb } from './db'
import { readMailHandoff, type StructuredMailHandoff } from './mail-handoff'
import {
  selectStructuredMailHandoff,
  structuredMailMaySubmit,
  type StructuredMailEvidence
} from './mailbox-settlement'
import type { TerminalMailTarget } from '../../agent-hooks/server/terminal-mail-target'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})
function database() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  return db
}

it('decodes real candidate rows without losing extra metadata, opaque handoffs or FIFO limits', () => {
  const db = database()
  db.db.exec('ALTER TABLE messages ADD COLUMN future_metadata TEXT')
  const first = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'first' })
  const second = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'second' })
  const uncertain = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'uncertain' })
  const opaque = JSON.stringify({
    kind: 'structured',
    phase: 'reserved',
    future: { permission: 'opaque', members: ['original'] }
  })
  db.db
    .prepare(`UPDATE messages SET handoff = ?, recovery_used = 1, payload = ?,
      thread_id = 'thread', sender_pane_key = 'tab:leaf', future_metadata = 'retained',
      created_at = '2026-01-01 00:00:00', delivered_at = '2026-01-02 00:00:00'
      WHERE id = ?`)
    .run(opaque, '{"result":"complete"}', first.id)
  db.db
    .prepare('UPDATE messages SET handoff = ? WHERE id = ?')
    .run('{"version":1,"kind":"unknown"}', uncertain.id)
  const select = (afterSequence: number, limit: number) =>
    db.getAutomaticMailCandidates('consumer', { afterSequence, excludeTypes: [], limit })
  const rows = select(0, 50)
  expect(rows).toEqual([db.getMessageById(first.id), db.getMessageById(second.id)])
  expect(rows[0]).toMatchObject({
    handoff: opaque,
    recovery_used: 1,
    future_metadata: 'retained',
    created_at: '2026-01-01T00:00:00Z',
    delivered_at: '2026-01-02T00:00:00Z'
  })
  expect(rows[1]).toMatchObject({
    handoff: null,
    recovery_used: 0,
    thread_id: null,
    payload: null,
    sender_pane_key: null,
    pointer_pty_id: null,
    pointer_process_incarnation: null
  })
  expect(select(0, 1)).toEqual([rows[0]])
  expect(select(first.sequence, 1)).toEqual([rows[1]])
  expect(db.getUnreadMessages('consumer').map((row) => row.id)).toEqual([
    first.id,
    second.id,
    uncertain.id
  ])
})

it('rejects a selected malformed SQLite row without mutating its mail or ownership', () => {
  const db = database()
  const message = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'invalid body' })
  db.db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(Buffer.from('blob'), message.id)
  const raw = () => db.db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id)
  const before = raw()
  expect(() =>
    db.getAutomaticMailCandidates('consumer', { afterSequence: 0, excludeTypes: [], limit: 50 })
  ).toThrow(z.ZodError)
  expect(raw()).toEqual(before)
  expect(before).toMatchObject({ read: 0, handoff: null, recovery_used: 0 })
})

it('terminal failure recovery is reserved once, revalidated before Enter, and cannot suppress fresh mail', () => {
  const db = database()
  const message = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'QA result' })
  const target: TerminalMailTarget = {
    paneKey: 'pane',
    process: { pid: 123, platform: 'linux', startTime: 'original-process' },
    owner: 'owner',
    turnKey: 'turn'
  }
  let abandoned = false
  const select = () =>
    selectTerminalMailHandoff({
      db,
      mailbox: 'consumer',
      target,
      wasAbandoned: () => abandoned,
      waiters: undefined,
      reservedTypes: undefined
    })
  expect(select().map((row) => row.id)).toEqual([message.id])
  db.markAsDelivered([message.id], 'consumer')
  expect(select()).toEqual([])
  abandoned = true
  const recovery = select()
  expect(recovery[0]?.recovery_used).toBe(1)
  const canSubmit = () => terminalMailHandoffCanSubmit(db, 'consumer', recovery, () => abandoned)
  expect(canSubmit()).toBe(true)
  abandoned = false
  expect(canSubmit()).toBe(false)
  abandoned = true
  db.recordUnknownMailRead(recovery)
  expect(canSubmit()).toBe(false)
  db.markAsDelivered([message.id], 'consumer')
  expect(select()).toEqual([])
  const fresh = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'new result' })
  expect(select().map((row) => row.id)).toEqual([fresh.id])
})

it('rotating a never-admitted recovery transport preserves its original failed-owner authorization', async () => {
  const db = database()
  const message = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'result' })
  const reference: StructuredMailHandoff = {
    version: 1,
    kind: 'structured',
    sessionId: 'session',
    epoch: 'destination-epoch',
    frontier: 'prior-host',
    operationId: 'old-operation',
    authorizationId: 'one-recovery',
    clientMessageId: 'old-operation',
    phase: 'reserved',
    authority: db.mailboxHandoffAuthority('consumer'),
    nonAdmission: 'refused',
    recoverySource: {
      sessionId: 'original-session',
      epoch: 'original-epoch',
      clientMessageId: 'original-failed-notice'
    }
  }
  db.reserveMailHandoff('consumer', message, reference, true)
  const evidence: StructuredMailEvidence = {
    epoch: 'destination-epoch',
    frontier: 'new-host',
    stopInForce: false,
    submission: undefined,
    owner: null,
    personStopped: false,
    diedTurnId: null
  }
  const selected = await selectStructuredMailHandoff({
    db,
    mailbox: 'consumer',
    sessionId: 'session',
    epoch: 'destination-epoch',
    frontier: 'new-host',
    waiters: undefined,
    reservedTypes: undefined,
    readEvidence: async (reference) =>
      reference.clientMessageId === 'original-failed-notice'
        ? {
            ...evidence,
            epoch: 'original-epoch',
            owner: { itemId: 'T1', turn: { turnId: 'T1', state: 'completed', outcome: 'failure' } }
          }
        : evidence
  })
  expect(selected?.reference).toMatchObject({
    authorizationId: 'one-recovery',
    recoverySource: {
      sessionId: 'original-session',
      epoch: 'original-epoch',
      clientMessageId: 'original-failed-notice'
    }
  })
  expect(selected?.reference.operationId).not.toBe('old-operation')
  if (!selected) {
    throw new Error('Missing reserved recovery')
  }
  expect(structuredMailMaySubmit(selected.reference, () => evidence)).toBe(false)
  expect(
    structuredMailMaySubmit(selected.reference, (source) =>
      source.sessionId === 'original-session'
        ? {
            ...evidence,
            epoch: 'original-epoch',
            owner: { itemId: 'T1', turn: { turnId: 'T1', state: 'completed', outcome: 'failure' } }
          }
        : evidence
    )
  ).toBe(true)
  expect(db.getMessageById(message.id)?.recovery_used).toBe(1)
  expect(readMailHandoff(db.getMessageById(message.id)?.handoff)).toEqual(selected?.reference)
})
