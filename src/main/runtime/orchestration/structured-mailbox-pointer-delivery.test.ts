import { join } from 'node:path'
import { statSync, existsSync } from 'node:fs'
import { JournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database'
import {
  readCommandReceipt,
  insertCommandReceiptIfAbsent
} from '../../native-chat/agent-session-journal/command-receipt-table'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from '../../native-chat/agent-session-journal/command-receipt-test-support'
import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { observeMailSqlWork } from './mail-sql-work.test-support'
import { mailTestResources } from './mail-handoff.test-fixture'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  ordinaryMailCreationId,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'

const resources = mailTestResources('ordinary-mail-discovery-')
function harness(realReceipts = false) {
  const directory = realReceipts ? resources.directory() : null
  const sourcePath = directory ? join(directory, 'source.db') : ':memory:'
  let db = new OrchestrationDb(sourcePath)
  resources.track({ close: () => db.close() })
  const receiptDatabase = directory ? resources.track(JournalHostDatabase.open(directory)) : null
  receiptDatabase?.transaction((database) => writeCommandReceiptTestRecord(database))
  const receipts = new Set<string>()
  let capacity = true
  const waiters = new Set<OrchestrationMessageWaiter>()
  const owner = {}
  const host: StructuredMailboxPointerHost = {
    admission: () => ({ owner, generation: '1', queuedBytes: capacity ? 0 : 1000 }),
    readHistory: () => ({ members: new Set(), opaque: true }),
    readCreation: vi.fn((id) => {
      if (!receiptDatabase) {
        return receipts.has(id) ? 'accepted' : 'absent'
      }
      const read = readCommandReceipt(receiptDatabase.db, { kind: 'global' }, id)
      return read.verdict === 'absent'
        ? 'absent'
        : read.verdict === 'readable' && read.receipt.status === 'accepted'
          ? 'accepted'
          : 'unknown'
    }),
    currentFence: () => 1,
    send: vi.fn(async (input) => {
      input.beforeRun()
      if (!capacity) {
        return { kind: 'capacity' }
      }
      receipts.add(input.operationId)
      return { kind: 'queued' }
    })
  }
  const bridge = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => waiters,
    resolveStructuredTarget: (mailbox) =>
      mailbox === 'consumer' ? { sessionId: 'session', dispatchId: null } : null,
    getCliCommand: () => 'orca',
    senderName: () => null,
    host
  })
  const insert = (subject = 'report') =>
    db.insertMessage({ from: 'worker', to: 'consumer', subject })
  const idle = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    get db() {
      return db
    },
    receiptDatabase,
    rebuildSourceIndex: () => {
      if (!directory) {
        throw new Error('file-backed corpus required')
      }
      bridge.resetForDatabaseChange()
      db.db.exec('DROP INDEX idx_messages_undelivered_source')
      db.close()
      const sizes = () =>
        Object.fromEntries(
          ['', '-wal', '-shm'].map((suffix) => [
            suffix || 'db',
            existsSync(sourcePath + suffix) ? statSync(sourcePath + suffix).size : 0
          ])
        )
      const before = sizes()
      const started = performance.now()
      db = new OrchestrationDb(sourcePath)
      const firstOpenMs = performance.now() - started
      const built = sizes()
      const pages = db.db.pragma('page_count', { simple: true })
      db.close()
      const reopening = performance.now()
      db = new OrchestrationDb(sourcePath)
      return {
        before,
        built,
        pages,
        firstOpenMs,
        reopenMs: performance.now() - reopening,
        busyTimeout: db.db.pragma('busy_timeout', { simple: true })
      }
    },
    accept: (row: { id: string; run_id: string }) => {
      const id = ordinaryMailCreationId(row)
      if (receiptDatabase) {
        receiptDatabase.transaction((database) =>
          insertCommandReceiptIfAbsent(
            database,
            { kind: 'global' },
            commandReceiptFixture({
              operationId: id,
              callerKey: 'trusted-local:orchestration:ordinary-mail',
              result: { kind: 'queued-draft', messageId: id }
            })
          )
        )
      } else {
        receipts.add(id)
      }
    },
    host,
    bridge,
    receipts,
    waiters,
    insert,
    idle,
    capacity: (value: boolean) => {
      capacity = value
    }
  }
}

it.each([false, true])(
  'retries ordinary creation across capacity/waiter changes with unavailable lineage=%s',
  async (relationReadFails) => {
    const h = harness()
    const relationRead = vi.spyOn(h.db, 'getRun')
    if (relationReadFails) {
      relationRead.mockImplementation(() => {
        throw new Error('lineage unavailable')
      })
    }
    const a = h.insert('first'),
      b = h.insert('second')
    h.capacity(false)
    h.bridge.deliverForHandle('consumer')
    await h.idle()
    expect(h.db.getMessageById(a.id)?.delivered_at).toBeNull()
    expect(vi.mocked(h.host.send).mock.calls.map(([input]) => input.operationId)).toEqual([
      ordinaryMailCreationId(a),
      ordinaryMailCreationId(b)
    ])
    h.waiters.add({ typeFilter: undefined })
    h.capacity(true)
    h.bridge.onJournalActivity('session')
    await h.idle()
    expect(h.receipts.size).toBe(0)
    h.waiters.clear()
    h.bridge.onConsumerChange('consumer')
    await vi.waitFor(() => expect(h.receipts.size).toBe(2))
    expect(h.db.getMessageById(b.id)?.delivered_at).not.toBeNull()
    const calls = vi.mocked(h.host.send).mock.calls.slice(-2)
    expect(calls.map(([input]) => input.body.from?.orchestration?.messages)).toEqual([
      [{ messageId: a.id, runId: a.run_id, from: 'worker' }],
      [{ messageId: b.id, runId: b.run_id, from: 'worker' }]
    ])
    expect(relationRead).toHaveBeenCalledTimes(4)
    expect(calls.map(([input]) => input.body.from?.senders[0].relation)).toEqual([
      undefined,
      undefined
    ])
    relationRead.mockRestore()
    h.bridge.resetForDatabaseChange()
  }
)

it.each([100, 1000])(
  'cold read-inclusive indexed recovery examines only N=%i undelivered recipient entries and no payload bytes',
  async (count) => {
    const h = harness(true)
    const accepted = []
    for (let n = 0; n < count; n++) {
      const row = h.insert(`accepted-${n}`)
      accepted.push(row.id)
      h.accept(row)
      h.db.db.prepare('UPDATE messages SET read = ? WHERE id = ?').run(n % 3, row.id)
      const delivered = h.insert('delivered noise')
      h.db.markAsDelivered([delivered.id], 'consumer')
      h.db.insertMessage({
        from: 'worker',
        to: 'other',
        subject: 'other recipient',
        body: 'b'.repeat(10000),
        payload: 'p'.repeat(10000)
      })
    }
    const openCost = h.rebuildSourceIndex()
    const receiptSql = observeMailSqlWork(
      h.receiptDatabase!.db,
      (sql) => sql.includes('FROM agent_session_command_receipts WHERE operation_id = ?'),
      'result_json',
      'visits'
    )
    const bodies = vi.spyOn(h.db, 'getMessageById')
    const sql = observeMailSqlWork(
      h.db.db,
      (query) =>
        query.includes('ORDER BY sequence LIMIT 50') && query.includes('delivered_at IS NULL'),
      'sequence',
      true
    )
    h.bridge.deliverForHandle('consumer')
    await vi.waitFor(() =>
      expect(
        h.db.db
          .prepare(
            'SELECT count(*) AS n FROM messages WHERE to_handle = ? AND delivered_at IS NULL'
          )
          .get('consumer')?.n
      ).toBe(0)
    )
    expect(sql.count()).toBe(count)
    expect(bodies).not.toHaveBeenCalled()
    expect(h.host.send).not.toHaveBeenCalled()
    expect(h.host.readCreation).toHaveBeenCalledTimes(count)
    const receiptBytecode = receiptSql.verify()
    expect(receiptSql.count()).toBe(count)
    expect(receiptSql.calls.reduce((sum, call) => sum + call.rows, 0)).toBe(count)
    expect(receiptSql.calls.reduce((sum, call) => sum + call.bytes, 0)).toBeGreaterThan(count * 100)
    const bytecode = sql.verify()
    expect(sql.calls.every((call) => !/\bbody\b|\bpayload\b/.test(call.original))).toBe(true)
    expect(sql.calls.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThan(count * 600)
    console.info(
      'cold source indexed candidate/bytes/receipt evidence',
      JSON.stringify({
        count,
        openCost,
        actualReceipts: {
          visits: receiptSql.count(),
          examinedResultJsonBytes: receiptSql.evaluatedBytes(),
          calls: receiptSql.calls,
          bytecode: [...new Set(receiptBytecode.map((row) => JSON.stringify(row.bytecode)))].map(
            (row) => JSON.parse(row)
          )
        },
        visits: sql.count(),
        calls: sql.calls,
        receiptLookups: vi.mocked(h.host.readCreation).mock.calls.length,
        sourceBodies: bodies.mock.calls.length,
        sourceBytes: sql.calls.reduce((sum, call) => sum + call.bytes, 0),
        bytecode: bytecode.map((row) => ({
          args: row.args,
          opcodes: row.bytecode.map((item) => item.opcode)
        }))
      })
    )
    receiptSql.restore()
    sql.reset()
    vi.mocked(h.host.readCreation).mockClear()
    for (let n = 0; n < 10; n++) {
      h.bridge.onJournalActivity('session')
      await h.idle()
    }
    expect(sql.count()).toBe(0)
    expect(h.host.readCreation).not.toHaveBeenCalled()
    const fresh = h.insert('new local')
    h.bridge.deliverForHandle('consumer')
    await vi.waitFor(() => expect(h.receipts.has(ordinaryMailCreationId(fresh))).toBe(true))
    expect(sql.count()).toBe(1)
    expect(bodies).toHaveBeenCalledExactlyOnceWith(fresh.id)
    sql.restore()
    h.bridge.resetForDatabaseChange()
  }
)
