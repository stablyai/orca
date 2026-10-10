import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalHostDatabase } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import {
  commandReceiptScope,
  type CommandReceipt,
  type CommandReceiptScope
} from './command-receipt-schema'
import { insertCommandReceiptIfAbsent, readCommandReceipt } from './command-receipt-table'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'

let root: string
let database: JournalHostDatabase
const globalScope = commandReceiptScope('caller-1', 'global')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-command-receipt-table-'))
  database = openTestJournalHostDatabase(root)
  database.transaction((db) => writeCommandReceiptTestRecord(db))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function insert(receipt: CommandReceipt, scope: CommandReceiptScope = globalScope) {
  return database.transaction((db) => insertCommandReceiptIfAbsent(db, scope, receipt))
}

function read(receipt: CommandReceipt, scope: CommandReceiptScope = globalScope) {
  return readCommandReceipt(database.db, scope, receipt.operationId)
}

function cancelReceipt(callerKey: string, turnId = 'turn-1') {
  return commandReceiptFixture({
    callerKey,
    method: 'agentSession.cancel',
    fingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.cancel',
      sessionId: 'session-1',
      fields: { turnId }
    }),
    result: { kind: 'no-op', outcome: { kind: 'cancel', cancelled: false, turnId } }
  })
}

describe('command receipt identity', () => {
  it('inserts a send once and replays the original receipt across callers with the same fingerprint', () => {
    const receipt = commandReceiptFixture()
    expect(read(receipt)).toEqual({ verdict: 'absent' })
    expect(insert(receipt)).toEqual({ inserted: true })
    expect(insert({ ...receipt, acceptedAt: 2000, callerKey: 'caller-2' })).toEqual({
      inserted: false,
      reason: 'duplicate',
      existing: { verdict: 'readable', receipt }
    })
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
  })

  it('reports a changed canonical hash, including a different method or chat, as conflict', () => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.transaction((db) => writeCommandReceiptTestRecord(db, 'session-2'))
    for (const target of [
      { method: 'agentSession.cancel', sessionId: 'session-1' },
      { method: 'agentSession.send', sessionId: 'session-2' }
    ]) {
      const changed = commandReceiptFixture({
        ...target,
        fingerprint: computeAgentSessionPayloadFingerprint({ ...target, fields: {} })
      })
      expect(insert(changed)).toEqual({
        inserted: false,
        reason: 'conflict',
        existing: { verdict: 'readable', receipt }
      })
    }
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
  })

  it('conflicts when the same caller sends and then stops with the same id', () => {
    const send = commandReceiptFixture()
    const stop = cancelReceipt(send.callerKey)
    const scope = commandReceiptScope(stop.callerKey)
    expect(insert(send)).toEqual({ inserted: true })
    expect(read(stop, scope)).toEqual({ verdict: 'readable', receipt: send })
    expect(insert(stop, scope)).toEqual({
      inserted: false,
      reason: 'conflict',
      existing: { verdict: 'readable', receipt: send }
    })
  })

  it('conflicts when one caller stops and another sends with the same id', () => {
    const stop = cancelReceipt('caller-1')
    expect(insert(stop, commandReceiptScope(stop.callerKey))).toEqual({ inserted: true })
    expect(insert(commandReceiptFixture({ callerKey: 'caller-2' }))).toEqual({
      inserted: false,
      reason: 'conflict',
      existing: { verdict: 'readable', receipt: stop }
    })
  })

  it('allows separate callers to stop with the same id', () => {
    for (const callerKey of ['caller-1', 'caller-2']) {
      const receipt = cancelReceipt(callerKey)
      const scope = commandReceiptScope(callerKey)
      expect(insert(receipt, scope)).toEqual({ inserted: true })
      expect(read(receipt, scope)).toEqual({ verdict: 'readable', receipt })
    }
  })

  it('allows another caller to stop with an id already used by a send', () => {
    const send = commandReceiptFixture()
    const stop = cancelReceipt('caller-2')
    const scope = commandReceiptScope(stop.callerKey)
    expect(insert(send)).toEqual({ inserted: true })
    expect(read(stop, scope)).toEqual({ verdict: 'absent' })
    expect(insert(stop, scope)).toEqual({ inserted: true })
    expect(read(stop, scope)).toEqual({ verdict: 'readable', receipt: stop })
  })

  it('treats a caller key literally named global as an ordinary caller', () => {
    const stop = cancelReceipt('global')
    const scope = commandReceiptScope(stop.callerKey)
    expect(insert(stop, scope)).toEqual({ inserted: true })
    expect(insert(cancelReceipt('caller-2'), commandReceiptScope('caller-2'))).toEqual({
      inserted: true
    })
    expect(read(stop, scope)).toEqual({ verdict: 'readable', receipt: stop })
    expect(insert(commandReceiptFixture())).toMatchObject({ inserted: false, reason: 'conflict' })
  })

  it.each([500, 1000])(
    'orders global candidates by insertion and checks every fingerprint (%i)',
    (acceptedAt) => {
      const first = cancelReceipt('caller-b', 'turn-b')
      const later = { ...cancelReceipt('caller-a', 'turn-a'), acceptedAt }
      expect(insert(first, commandReceiptScope(first.callerKey))).toEqual({ inserted: true })
      expect(insert(later, commandReceiptScope(later.callerKey))).toEqual({ inserted: true })
      expect(read(later)).toEqual({ verdict: 'readable', receipt: first })
      expect(insert({ ...later, callerKey: 'caller-c' })).toEqual({
        inserted: false,
        reason: 'duplicate',
        existing: { verdict: 'readable', receipt: later }
      })
      expect(insert(commandReceiptFixture())).toEqual({
        inserted: false,
        reason: 'conflict',
        existing: { verdict: 'readable', receipt: first }
      })
    }
  )

  it('refuses a caller that does not match its namespace', () => {
    const receipt = commandReceiptFixture()
    expect(() => insert(receipt, commandReceiptScope('caller-2'))).toThrow(
      'command caller does not match its scope'
    )
    expect(read(receipt)).toEqual({ verdict: 'absent' })
  })

  it('requires the chat record to exist and does not leave an orphan receipt', () => {
    const receipt = commandReceiptFixture({ sessionId: 'missing-chat' })
    expect(() => insert(receipt)).toThrow(/FOREIGN KEY/i)
    expect(read(receipt)).toEqual({ verdict: 'absent' })
  })

  it('requires a receipt to be written inside an open transaction', () => {
    const receipt = commandReceiptFixture()
    expect(() => insertCommandReceiptIfAbsent(database.db, globalScope, receipt)).toThrow(
      /inside an open transaction/
    )
    expect(read(receipt)).toEqual({ verdict: 'absent' })
  })

  it('throws and rolls back an unexpected key collision after an absent lookup', () => {
    database.db
      .exec(`CREATE TRIGGER collide_command_receipt BEFORE INSERT ON agent_session_command_receipts
      BEGIN
        INSERT INTO agent_session_command_receipts
          (operation_id, session_id, caller_key, method, fingerprint, status, result_json, rejection_json, accepted_at)
          VALUES (NEW.operation_id, NEW.session_id, NEW.caller_key, NEW.method, NEW.fingerprint,
            NEW.status, NEW.result_json, NEW.rejection_json, NEW.accepted_at);
      END`)
    const receipt = commandReceiptFixture()
    expect(() => insert(receipt)).toThrow(/UNIQUE constraint/i)
    expect(read(receipt)).toEqual({ verdict: 'absent' })
    expect(database.db.isTransaction).toBe(false)
  })
})

describe('command receipt outcomes and lifetime', () => {
  it('round trips a queued-draft pointer without retaining its body', () => {
    const receipt = commandReceiptFixture({
      result: { kind: 'queued-draft', messageId: 'draft-1' }
    })
    insert(receipt)
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
  })

  it.each([
    { kind: 'cancel', cancelled: false, turnId: 'turn-1' },
    { kind: 'cancel', cancelled: false },
    { kind: 'queue-resume', resumed: false }
  ] as const)('reads the small no-op outcome $kind', (outcome) => {
    const receipt = commandReceiptFixture({ result: { kind: 'no-op', outcome } })
    insert(receipt)
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
  })

  it('retains a refused outcome with its code, message and details', () => {
    const { result: _result, ...identity } = commandReceiptFixture()
    const receipt: CommandReceipt = {
      ...identity,
      status: 'rejected',
      rejection: {
        reference: { code: 'agent_session_operation_invalid', details: { reason: 'promptGone' } },
        message: 'The prompt is no longer available.'
      }
    }
    insert(receipt)
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
    expect(insert(commandReceiptFixture())).toMatchObject({ inserted: false, reason: 'duplicate' })
  })

  it('preserves receipts across record upserts and cascades only on record deletion', () => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.transaction((db) => writeCommandReceiptTestRecord(db, 'session-1', '{"updated":true}'))
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
    database.transaction((db) => writeCommandReceiptTestRecord(db, 'session-1', null))
    expect(read(receipt)).toEqual({ verdict: 'absent' })
  })
})

describe('unreadable command receipts', () => {
  it.each([
    ['result_json', '{'],
    ['result_json', '{"kind":"journal-row","epoch":"e1","sequence":0}'],
    ['result_json', '{"kind":"future-result"}'],
    ['result_json', '{"kind":"queued-draft","messageId":""}'],
    ['result_json', null],
    ['status', 'pending'],
    ['method', ''],
    ['fingerprint', ''],
    ['accepted_at', -1],
    ['caller_key', ''],
    ['rejection_json', '{}']
  ])('preserves the key when %s holds malformed data %s', (column, value) => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.db.prepare(`UPDATE agent_session_command_receipts SET ${column} = ?`).run(value)
    const existing = {
      verdict: 'unreadable',
      scope: globalScope,
      operationId: receipt.operationId
    }
    expect(read(receipt)).toEqual(existing)
    expect(insert(receipt)).toEqual({ inserted: false, reason: 'unreadable', existing })
  })

  it('treats a malformed rejection as unreadable rather than granting another execution', () => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.db
      .prepare(`UPDATE agent_session_command_receipts SET status = 'rejected', result_json = NULL,
        rejection_json = ? WHERE caller_key = ? AND operation_id = ?`)
      .run(
        JSON.stringify({
          reference: { code: 'agent_session_operation_invalid', details: { reason: 'madeUp' } }
        }),
        receipt.callerKey,
        receipt.operationId
      )
    expect(read(receipt)).toMatchObject({ verdict: 'unreadable' })
    expect(insert(receipt)).toMatchObject({ inserted: false, reason: 'unreadable' })
  })

  it('refuses a global lookup if any candidate is unreadable, even after a matching receipt', () => {
    const readable = cancelReceipt('caller-a')
    const unreadable = cancelReceipt('caller-b')
    insert(readable, commandReceiptScope(readable.callerKey))
    insert(unreadable, commandReceiptScope(unreadable.callerKey))
    database.db
      .prepare("UPDATE agent_session_command_receipts SET result_json = '{' WHERE caller_key = ?")
      .run(unreadable.callerKey)
    expect(read(readable, commandReceiptScope(readable.callerKey))).toEqual({
      verdict: 'readable',
      receipt: readable
    })
    const existing = {
      verdict: 'unreadable',
      scope: globalScope,
      operationId: readable.operationId
    }
    expect(read(readable)).toEqual(existing)
    expect(insert({ ...readable, callerKey: 'caller-c' })).toEqual({
      inserted: false,
      reason: 'unreadable',
      existing
    })
  })

  it('reads an oversized accepted_at integer as unreadable', () => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.db.exec('UPDATE agent_session_command_receipts SET accepted_at = 9007199254740993')
    expect(read(receipt)).toEqual({
      verdict: 'unreadable',
      scope: globalScope,
      operationId: receipt.operationId
    })
    expect(insert(receipt)).toMatchObject({ inserted: false, reason: 'unreadable' })
  })

  it('reads a table missing an expected column as unreadable', () => {
    database.db.exec(
      'ALTER TABLE agent_session_command_receipts RENAME COLUMN result_json TO future_result_json'
    )
    const receipt = commandReceiptFixture()
    for (const scope of [globalScope, commandReceiptScope(receipt.callerKey)]) {
      expect(read(receipt, scope)).toEqual({
        verdict: 'unreadable',
        scope,
        operationId: receipt.operationId
      })
      expect(insert(receipt, scope)).toMatchObject({ inserted: false, reason: 'unreadable' })
    }
  })

  it.each([
    [5, 'database is locked'],
    [10, 'disk I/O error']
  ] as const)('propagates operational SQLite error %i', (errcode, message) => {
    const failure = Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })
    const prepare = vi.spyOn(database.db, 'prepare').mockImplementationOnce(() => {
      throw failure
    })
    try {
      expect(() => read(commandReceiptFixture())).toThrow(failure)
    } finally {
      prepare.mockRestore()
    }
  })
})
