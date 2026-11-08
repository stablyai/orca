import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { JournalSqlBatch, JournalSqlBatchError } from './journal-sql-batch'
import { takeJournalSqlReadyBatch } from './journal-sql-ready-batch'
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
  const answer = await batch.run(
    [
      { command: 1, normal: true },
      { command: 2, normal: true },
      { command: 3, normal: false }
    ],
    (id) => {
      const previous = db.prepare('SELECT id FROM writes ORDER BY id').all()
      db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'written')
      if (id === 2) {
        throw failure
      }
      return previous
    }
  )
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

it.each([
  { normal: [true, true], synchronous: 1 },
  { normal: [true, false], synchronous: 2 }
])('uses batch durability $synchronous and restores FULL before the next batch', async (input) => {
  const { db, batch } = fixture()
  const answer = await batch.run(
    input.normal.map((normal, id) => ({ command: id, normal })),
    (id) => {
      db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'written')
      return db.pragma('synchronous', { simple: true })
    }
  )
  expect(answer.outcomes).toEqual([
    { committed: true, value: input.synchronous },
    { committed: true, value: input.synchronous }
  ])
  expect(db.pragma('synchronous', { simple: true })).toBe(2)
})

it('leaves newly admitted work for a new drain with its own durability', async () => {
  const { db, batch } = fixture()
  const admitted = [{ command: 1, normal: true }]
  const first = await batch.run(admitted, (id) => {
    db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'stream')
    admitted.push({ command: 2, normal: false })
    return id
  })
  expect(first.outcomes).toEqual([{ committed: true, value: 1 }])
  expect(db.prepare('SELECT id, value FROM writes').all()).toEqual([{ id: 1, value: 'stream' }])
  const send = await batch.run(admitted.slice(1), (id) => {
    db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'send')
    return db.pragma('synchronous', { simple: true })
  })
  expect(send.outcomes).toEqual([{ committed: true, value: 2 }])
  expect(db.prepare('SELECT id, value FROM writes ORDER BY id').all()).toEqual([
    { id: 1, value: 'stream' },
    { id: 2, value: 'send' }
  ])
})

it('commits a control receipt before later streamed work with its own durability', async () => {
  const { db, batch } = fixture()
  const stream = (id: number): JournalSqlRequest => ({
    id,
    command: {
      type: 'write',
      command: {
        target: { sessionId: 'session', epoch: 'epoch', ownerToken: 'owner' },
        operation: {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'output' },
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'output' }] },
          options: { fence: 1, turnScope: { kind: 'thread' } }
        }
      }
    }
  })
  const queue: JournalSqlRequest[] = [
    stream(1),
    { id: 2, command: { type: 'effects', effects: [] } },
    stream(3)
  ]
  const commit = async () =>
    batch.run(
      takeJournalSqlReadyBatch(queue, () => true).map(({ request, normal }) => ({
        command: request,
        normal
      })),
      (request) => {
        db.prepare('INSERT INTO writes VALUES (?, ?)').run(request.id, 'written')
        return { id: request.id, durability: db.pragma('synchronous', { simple: true }) }
      }
    )
  expect((await commit()).outcomes).toEqual([{ committed: true, value: { id: 1, durability: 1 } }])
  expect((await commit()).outcomes).toEqual([{ committed: true, value: { id: 2, durability: 2 } }])
  expect(db.prepare('SELECT id FROM writes ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }])
  expect((await commit()).outcomes).toEqual([{ committed: true, value: { id: 3, durability: 1 } }])
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
      await batch.run([{ command: 1, normal: false }], (id) => {
        db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'written')
        return id
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(JournalSqlBatchError)
    expect(failure).toMatchObject({ outcome: 'indeterminate' })
    expect(db.prepare('SELECT id FROM writes').all()).toEqual(committed ? [{ id: 1 }] : [])
    await expect(batch.run([{ command: 2, normal: false }], (id) => id)).rejects.toThrow(
      expect.objectContaining({ outcome: 'not-dispatched' })
    )
    expect(db.prepare('SELECT id FROM writes').all()).toEqual(committed ? [{ id: 1 }] : [])
  }
)

it('acknowledges a committed stream even when restoring FULL fails afterwards', async () => {
  const { db, batch } = fixture()
  const pragma = db.pragma.bind(db)
  let committed = false
  const failure = new Error('FULL setting failed')
  vi.spyOn(db, 'pragma').mockImplementation((sql, options) => {
    if (sql === 'synchronous = FULL' && committed) {
      throw failure
    }
    return pragma(sql, options)
  })
  const answer = await batch.run([{ command: 1, normal: true }], (id) => {
    db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'written')
    committed = true
    return id
  })
  expect(answer).toEqual({ outcomes: [{ committed: true, value: 1 }], postcommit: failure })
  expect(db.prepare('SELECT id FROM writes').all()).toEqual([{ id: 1 }])
  expect(batch.fault).toBe(failure)
})

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
    batch.run([{ command: 1, normal: false }], (id) => {
      db.prepare('INSERT INTO writes VALUES (?, ?)').run(id, 'uncommitted')
      throw new Error('command failed')
    })
  ).rejects.toThrow(expect.objectContaining({ outcome: 'indeterminate', rollback }))
  expect(db.isTransaction).toBe(true)
  await expect(batch.run([{ command: 2, normal: false }], (id) => id)).rejects.toThrow(
    expect.objectContaining({ outcome: 'not-dispatched' })
  )
  exec('ROLLBACK')
  expect(db.prepare('SELECT id FROM writes').all()).toEqual([])
})
