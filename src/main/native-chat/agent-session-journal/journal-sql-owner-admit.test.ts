import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { JournalSqlRequest } from './journal-sql-protocol'

// RR-C1-08: a maintenance request asks its admit last, just before it is posted to the writer
// worker. One that waited for record installation and was withdrawn meanwhile posts nothing.

const worker = new (class extends EventEmitter {
  readonly posted: JournalSqlRequest[] = []
  postMessage(message: JournalSqlRequest) {
    this.posted.push(message)
  }
})()

vi.mock('../../worker-threads/worker-thread-spawn', () => ({ spawnWorkerThread: () => worker }))

const { JournalSqlOwner } = await import('./journal-sql-owner')

const kinds = () =>
  worker.posted.map((message) =>
    message.command.type === 'maintenance' ? message.command.operation.kind : message.command.type
  )

it('posts no withdrawn write that waited for record installation, and posts an admitted one', async () => {
  const owner = new JournalSqlOwner('journal.db', 'state', 'worker.js')
  const installing = owner.installRecords()
  let current = true
  const probe = { kind: 'connector-replies-probe' as const, keys: [] }
  const withdrawn = owner.maintain(probe, () => current)
  const admitted = owner.maintain(probe, () => true)
  current = false
  const install = worker.posted[0]!
  worker.emit('message', {
    type: 'maintenance',
    id: install.id,
    result: { kind: 'records', records: {} }
  })
  await installing
  expect(await withdrawn).toBeNull()
  const sent = worker.posted.at(-1)!
  worker.emit('message', { type: 'maintenance', id: sent.id, result: [] })
  expect(await admitted).toEqual([])
  expect(kinds()).toEqual(['records-install', 'connector-replies-probe'])
})
