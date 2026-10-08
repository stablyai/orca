import Database from '../../sqlite/sync-database'
import { expect, it } from 'vitest'
import {
  decodeProfileStateWriterError,
  encodeProfileStateWriterError
} from './profile-state-writer-errors'
import {
  createTerminalSessionStateSaveFailureMessage,
  isTerminalSessionStorageCapacityFailure
} from '../../../shared/terminal-session-state-save-failure'

it.each(['ENOSPC', 'EDQUOT', 'SQLITE_FULL', 'EACCES', 'SQLITE_BUSY'])(
  'preserves capacity evidence across the writer boundary for %s',
  (code) => {
    const error = new Error('private path must not cross the worker boundary', {
      cause: Object.assign(new Error('private details'), { code })
    })
    const encoded = encodeProfileStateWriterError(error)
    expect(encoded.message).toBe('Profile state persistence failed')
    const decoded = decodeProfileStateWriterError(JSON.parse(JSON.stringify(encoded)))
    const capacity = ['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(code)
    expect(
      isTerminalSessionStorageCapacityFailure(createTerminalSessionStateSaveFailureMessage(decoded))
    ).toBe(capacity)
  }
)

it('classifies a real SQLite capacity failure after worker serialization', () => {
  const db = new Database(':memory:')
  try {
    db.exec('PRAGMA page_size=512; CREATE TABLE writes(data BLOB); PRAGMA max_page_count=2')
    let failure: unknown
    try {
      db.exec('INSERT INTO writes VALUES (zeroblob(4096))')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
    const decoded = decodeProfileStateWriterError(encodeProfileStateWriterError(failure))
    expect(
      isTerminalSessionStorageCapacityFailure(createTerminalSessionStateSaveFailureMessage(decoded))
    ).toBe(true)
    db.exec("INSERT INTO writes VALUES ('small')")
  } finally {
    db.close()
  }
})
