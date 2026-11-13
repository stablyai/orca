import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { openRelayDatabase } from './database.js'

it('releases queued work and close after a SQLite transaction cannot acquire its lock', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-sqlite-queue-'))
  let connection: DatabaseSync | undefined
  const prepare = DatabaseSync.prototype.prepare
  // Keep the native handle reachable for cleanup even if a queue regression strands close().
  const capture = vi
    .spyOn(DatabaseSync.prototype, 'prepare')
    .mockImplementation(function (this: DatabaseSync, sql) {
      connection = this
      return prepare.call(this, sql)
    })
  const database = await openRelayDatabase({ dataDir })
  capture.mockRestore()
  const blocker = new DatabaseSync(join(dataDir, 'orca-relay.sqlite'))
  try {
    await database.query('CREATE TABLE queue_progress (value INTEGER)')
    await database.query('INSERT INTO queue_progress VALUES (0)')
    blocker.exec('BEGIN IMMEDIATE')
    await expect(database.transaction(async () => undefined)).rejects.toThrow('database is locked')
    blocker.exec('ROLLBACK')
    await database.transaction(async (transaction) => {
      await transaction.query('UPDATE queue_progress SET value = value + 1')
    })
    expect(await database.query('SELECT value FROM queue_progress')).toEqual([{ value: 1 }])
    await database.close()
  } finally {
    capture.mockRestore()
    blocker.close()
    if (connection?.isOpen) connection.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('does not roll back a transaction when BEGIN failed before taking ownership', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-sqlite-owner-'))
  let connection: DatabaseSync | undefined
  const prepare = DatabaseSync.prototype.prepare
  const capture = vi
    .spyOn(DatabaseSync.prototype, 'prepare')
    .mockImplementation(function (this: DatabaseSync, sql) {
      connection = this
      return prepare.call(this, sql)
    })
  const database = await openRelayDatabase({ dataDir })
  capture.mockRestore()
  try {
    await database.query('CREATE TABLE queue_owner (value INTEGER)')
    await database.query('BEGIN IMMEDIATE')
    await database.query('INSERT INTO queue_owner VALUES (7)')
    await expect(database.transaction(async () => undefined)).rejects.toThrow(
      'cannot start a transaction within a transaction'
    )
    expect(await database.query('SELECT value FROM queue_owner')).toEqual([{ value: 7 }])
    await database.query('ROLLBACK')
    expect(await database.query('SELECT value FROM queue_owner')).toEqual([])
    await database.close()
  } finally {
    capture.mockRestore()
    if (connection?.isOpen) connection.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
