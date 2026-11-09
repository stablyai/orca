import Database from '../../sqlite/sync-database'
import { expect, it } from 'vitest'
import {
  decodeProfileStateWriterError,
  encodeProfileStateWriterError
} from './profile-state-writer-errors'
import {
  createTerminalSessionStateSaveFailureMessage,
  isTerminalSessionStorageCapacityFailure
} from '../../../shared/workspace-session/terminal-session-state-save-failure'

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
