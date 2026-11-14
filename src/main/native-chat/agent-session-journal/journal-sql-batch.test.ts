import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { JournalSqlBatch, JournalSqlBatchError } from './journal-sql-batch'
import { prepareJournalSqlRequest, takeJournalSqlReadyBatch } from './journal-sql-ready-batch'
import { message } from './journal-sql-message.test-fixture'
import type { JournalSqlRequest } from './journal-sql-protocol'

const databases: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec('CREATE TABLE writes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  return { db, batch: new JournalSqlBatch(db) }
}

it('rolls back a failed command while later commands see preceding successful writes', async () => {
  const { db, batch } = fixture()
  const failure = new Error('command failed')
  const answer = await batch.run([1, 2, 3], (id) => {
    const previous = db.prepare('SELECT id FROM writes ORDER BY id').all()
    db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'written')
    if (id === 2) {
      throw failure
    }
    return previous
  })
  expect(answer).toEqual({
    outcomes: [
      { committed: true, value: [] },
      { committed: false, error: failure },
      { committed: true, value: [{ id: 1 }] }
    ]
  })
  expect(db.prepare('SELECT id, value FROM writes ORDER BY id').all()).toEqual([
    { id: 1, value: 'written' },
    { id: 3, value: 'written' }
  ])
  expect(db.isTransaction).toBe(false)
})

it('leaves newly admitted work for a new drain', async () => {
  const { db, batch } = fixture()
  const admitted = [1]
  const first = await batch.run(admitted, (id) => {
    db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'stream')
    admitted.push(2)
    return id
  })
  expect(first.outcomes).toEqual([{ committed: true, value: 1 }])
  expect(db.prepare('SELECT id, value FROM writes').all()).toEqual([{ id: 1, value: 'stream' }])
  const send = await batch.run(admitted.slice(1), (id) => {
    db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'send')
    return id
  })
  expect(send.outcomes).toEqual([{ committed: true, value: 2 }])
  expect(db.prepare('SELECT id, value FROM writes ORDER BY id').all()).toEqual([
    { id: 1, value: 'stream' },
    { id: 2, value: 'send' }
  ])
})

it('keeps bounded snapshot prefixes and controls in enqueue order', async () => {
  const { db, batch } = fixture()
  const stream = (id: number, steps: number, text = 'output'): JournalSqlRequest =>
    prepareJournalSqlRequest(id, {
      type: 'write',
      command: {
        target: { sessionId: `session${id}`, epoch: 'epoch', ownerToken: 'owner' },
        operation: {
          kind: 'steps',
          steps: Array.from({ length: steps }, () => ({
            kind: 'resolved-item',
            reservedBytes: Buffer.byteLength(text, 'utf8') + 1024,
            resolution: { ...message(text), kind: 'text-snapshot' },
            options: { fence: 1, turnScope: { kind: 'thread' } }
          }))
        },
        savedAt: 100
      }
    })
  const queue: JournalSqlRequest[] = [
    stream(1, 32),
    stream(2, 32),
    stream(3, 1),
    { id: 4, command: { type: 'effects', effects: [] } },
    stream(5, 1, 'x'.repeat(700 * 1024)),
    stream(6, 1, 'x'.repeat(700 * 1024))
  ]
  const commit = async () =>
    batch.run(takeJournalSqlReadyBatch(queue), (request) => {
      db.prepare('INSERT INTO writes VALUES (?, ?)').run(request.id, 'written')
      return request.id
    })
  expect((await commit()).outcomes).toEqual([
    { committed: true, value: 1 },
    { committed: true, value: 2 }
  ])
  expect(db.prepare('SELECT id FROM writes ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }])
  expect((await commit()).outcomes).toEqual([{ committed: true, value: 3 }])
  expect((await commit()).outcomes).toEqual([{ committed: true, value: 4 }])
  expect((await commit()).outcomes).toEqual([{ committed: true, value: 5 }])
  expect((await commit()).outcomes).toEqual([{ committed: true, value: 6 }])
})

it.each([false, true])(
  'treats a lost COMMIT answer as indeterminate, whether the commit took effect: %s',
  async (committed) => {
    const { db, batch } = fixture()
    const exec = db.exec.bind(db)
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') {
        if (committed) {
          exec(sql)
        }
        throw new Error('COMMIT answer lost')
      }
      exec(sql)
    })
    let failure: unknown
    try {
      await batch.run([1], (id) => {
        db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'written')
        return id
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(JournalSqlBatchError)
    expect(failure).toMatchObject({ outcome: 'indeterminate' })
    expect(db.prepare('SELECT id FROM writes').all()).toEqual(committed ? [{ id: 1 }] : [])
    await expect(batch.run([2], (id) => id)).rejects.toThrow(
      expect.objectContaining({ outcome: 'not-dispatched' })
    )
    expect(db.prepare('SELECT id FROM writes').all()).toEqual(committed ? [{ id: 1 }] : [])
  }
)

it('does not claim rollback when both command and outer rollback fail', async () => {
  const { db, batch } = fixture()
  const exec = db.exec.bind(db)
  const rollback = new Error('rollback failed')
  vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql.startsWith('ROLLBACK')) {
      throw rollback
    }
    exec(sql)
  })
  await expect(
    batch.run([1], (id) => {
      db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'uncommitted')
      throw new Error('command failed')
    })
  ).rejects.toThrow(expect.objectContaining({ outcome: 'indeterminate', rollback }))
  expect(db.isTransaction).toBe(true)
  await expect(batch.run([2], (id) => id)).rejects.toThrow(
    expect.objectContaining({ outcome: 'not-dispatched' })
  )
  exec('ROLLBACK')
  expect(db.prepare('SELECT id FROM writes').all()).toEqual([])
})
