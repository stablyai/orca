import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { openPushDatabase } from './push-database.js'

it('releases queued work and close after a SQLite transaction cannot acquire its lock', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-push-sqlite-queue-'))
  let connection: DatabaseSync | undefined
  const prepare = DatabaseSync.prototype.prepare
  // Keep the native handle reachable for cleanup even if a queue regression strands close().
  const capture = vi
    .spyOn(DatabaseSync.prototype, 'prepare')
    .mockImplementation(function (this: DatabaseSync, sql) {
      connection = this
      return prepare.call(this, sql)
    })
  const database = await openPushDatabase({ dataDir })
  capture.mockRestore()
  const blocker = new DatabaseSync(join(dataDir, 'orca-push.sqlite'))
  try {
    await database.query('CREATE TABLE queue_progress (value INTEGER)')
    await database.query('INSERT INTO queue_progress VALUES (0)')
    blocker.exec('BEGIN IMMEDIATE')
    const operation = vi.fn(async () => undefined)
    await expect(database.transaction(operation)).rejects.toThrow('database is locked')
    let lockFailures = 0
    const blocked = Array.from({ length: 5 }, () =>
      database.transaction(operation).catch(() => {
        lockFailures += 1
      })
    )
    await setImmediate()
    expect(lockFailures).toBe(5)
    await Promise.all(blocked)
    expect(operation).not.toHaveBeenCalled()
    blocker.exec('ROLLBACK')
    let completed = 0
    const pending = Array.from({ length: 100 }, () =>
      database.transaction(async (transaction) => {
        await transaction.query('UPDATE queue_progress SET value = value + 1')
        completed += 1
      })
    )
    for (const request of pending) void request.catch(() => undefined)
    await setImmediate()
    expect(completed).toBe(100)
    await Promise.all(pending)
    expect(await database.query('SELECT value FROM queue_progress')).toEqual([{ value: 100 }])
    let closed = false
    const closing = database.close().then(() => {
      closed = true
    })
    await setImmediate()
    expect(closed).toBe(true)
    await closing
  } finally {
    capture.mockRestore()
    blocker.close()
    if (connection?.isOpen) connection.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('does not roll back a transaction when BEGIN failed before taking ownership', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-push-sqlite-owner-'))
  let connection: DatabaseSync | undefined
  const prepare = DatabaseSync.prototype.prepare
  const capture = vi
    .spyOn(DatabaseSync.prototype, 'prepare')
    .mockImplementation(function (this: DatabaseSync, sql) {
      connection = this
      return prepare.call(this, sql)
    })
  const database = await openPushDatabase({ dataDir })
  capture.mockRestore()
  try {
    await database.query('CREATE TABLE queue_owner (value INTEGER)')
    await database.query('BEGIN IMMEDIATE')
    await database.query('INSERT INTO queue_owner VALUES (7)')
    await expect(database.transaction(async () => undefined)).rejects.toThrow(
      'cannot start a transaction within a transaction'
    )
    expect(connection?.isTransaction).toBe(true)
    let rows: unknown
    void database.query('SELECT value FROM queue_owner').then((result) => {
      rows = result
    })
    await setImmediate()
    expect(rows).toEqual([{ value: 7 }])
    await database.query('ROLLBACK')
    expect(await database.query('SELECT value FROM queue_owner')).toEqual([])
    await database.close()
  } finally {
    capture.mockRestore()
    if (connection?.isOpen) connection.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
