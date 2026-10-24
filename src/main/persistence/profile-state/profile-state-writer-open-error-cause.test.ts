import { expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  decodeProfileStateWriterError,
  encodeProfileStateWriterError
} from './profile-state-writer-errors'
import { ProfileStateDatabaseOpenError } from './profile-state-database-errors'

function acrossWorker(error: unknown): Error {
  return decodeProfileStateWriterError(
    JSON.parse(JSON.stringify(encodeProfileStateWriterError(error)))
  )
}

// #27333: the startup failure logged `cause: undefined`, hiding which SQLite call failed.
it('keeps the SQLite failure behind a database open error across the writer boundary', () => {
  const sqliteFailure = Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 261
  })
  const decoded = acrossWorker(
    new ProfileStateDatabaseOpenError(
      'unreadable',
      'Unable to initialize profile state database',
      sqliteFailure
    )
  )

  expect(decoded).toBeInstanceOf(ProfileStateDatabaseOpenError)
  expect(decoded.cause).toBeInstanceOf(Error)
  expect(decoded.cause).toMatchObject({
    code: 'ERR_SQLITE_ERROR',
    errcode: 261,
    message: 'database is locked'
  })
})

it('carries a real SQLite error code from a failed open', () => {
  const db = new Database(':memory:')
  let failure: unknown
  try {
    db.exec('SELECT * FROM missing_table')
  } catch (error) {
    failure = error
  } finally {
    db.close()
  }
  const decoded = acrossWorker(
    new ProfileStateDatabaseOpenError('unreadable', 'open failed', failure)
  )

  expect(decoded.cause).toMatchObject({
    code: 'ERR_SQLITE_ERROR',
    errcode: 1,
    message: expect.stringContaining('missing_table')
  })
})

it('keeps a cause-less open error cause-less', () => {
  const decoded = acrossWorker(new ProfileStateDatabaseOpenError('unreadable', 'gone'))
  expect(decoded).toBeInstanceOf(ProfileStateDatabaseOpenError)
  expect(decoded.cause).toBeUndefined()
})
