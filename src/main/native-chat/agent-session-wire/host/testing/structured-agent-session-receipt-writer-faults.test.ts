import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { journalSqlWorkerPath } from '../../../agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { journalDomainDatabasePath } from '../../../agent-session-journal/database/journal-host-database'
import { createQueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  claudeReceiptIngress,
  openReceiptStream
} from './structured-agent-session-provider-receipt-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_SESSION as CHAT,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data.test-fixture'

async function faultingWriter(root: string, fault: string): Promise<string> {
  const path = join(root, 'faulting-writer.cjs')
  await writeFile(
    path,
    `
    const { DatabaseSync } = require('node:sqlite')
    const fault = ${JSON.stringify(fault)}
    const exec = DatabaseSync.prototype.exec
    const prepare = DatabaseSync.prototype.prepare
    const armed = new WeakSet()
    const failRollback = new WeakSet()
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('INSERT INTO journal_items(')) {
        const run = statement.run
        statement.run = (...bindings) => {
          const result = run.apply(statement, bindings)
          if (bindings[2] === 'orca:fault-target') armed.add(this)
          return result
        }
      }
      return statement
    }
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'ROLLBACK' && failRollback.delete(this)) {
        throw new Error('injected rollback failure')
      }
      if (sql === 'COMMIT' && armed.delete(this)) {
        if (fault === 'after') exec.call(this, 'COMMIT')
        if (fault === 'connection') this.close()
        if (fault === 'rollback') failRollback.add(this)
        throw Object.assign(new Error('injected ' + fault), {
          code: 'ERR_SQLITE_ERROR', errcode: fault === 'disk-full' ? 13 : 10
        })
      }
      return exec.call(this, sql)
    }
    require(${JSON.stringify(journalSqlWorkerPath())})
  `
  )
  return path
}

it.each(['disk-full', 'before', 'after', 'rollback', 'connection'])(
  'keeps ordinary write disposition and durable event order under %s with or without receipts',
  async (fault) => {
    const run = async (receipts: boolean) => {
      const rig = await createQueuedMessageTestRig({
        agent: 'claude',
        writerBundle: (root) => faultingWriter(root, fault),
        hostDeps: { logger: { warn: () => {}, error: () => {} } }
      })
      try {
        await rig.workingSend()
        await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
        const journal = (await rig.host.conversation(CHAT)).journal
        const stream = receipts ? await openReceiptStream(rig) : undefined
        const ingress = claudeReceiptIngress(rig)
        if (stream) {
          ingress.lifecycle('queued', NOW + 100)
          await eventually(() => expect(stream.frames).toHaveLength(2))
        }
        await rig.host.serialize(CHAT, async () => {})
        const position = journal.cursor().sequence
        const outcome = (id: string) =>
          journal
            .appendItem(
              { provider: 'orca', clientMessageId: id },
              { kind: 'status', text: id },
              { fence: ingress.fence, turnScope: { kind: 'thread' }, observedAt: NOW + 300 }
            )
            .then(
              (row) => ({ sequence: row.cursor.sequence - position }),
              (error: unknown) => ({
                error: error instanceof Error ? error.message : String(error)
              })
            )
        const first = await outcome('fault-target')
        const successor = await outcome('successor')
        stream?.close()
        // A failed rollback may leave the writer in a transaction. Read committed rows without
        // running database initialization or trying to reserve a write lock in the assertion.
        const db = new DatabaseSync(journalDomainDatabasePath(rig.root), { readOnly: true })
        try {
          const durable = db
            .prepare(`SELECT item_id,sequence FROM journal_items
            WHERE session_id=? AND item_id IN ('orca:fault-target','orca:successor') ORDER BY sequence`)
            .all(CHAT)
            .map((row) => [row.item_id, Number(row.sequence) - position])
          return { first, successor, durable }
        } finally {
          db.close()
        }
      } finally {
        const [result] = await Promise.allSettled([rig.dispose()])
        if (result.status === 'rejected') {
          expect(['after', 'rollback', 'connection']).toContain(fault)
        }
      }
    }
    const baseline = await run(false)
    expect(baseline.first).toHaveProperty('error')
    expect(await run(true)).toEqual(baseline)
  },
  30_000
)
