import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import '../automation-runs/profile-state-automation-runs-model'
import { openProfileStateDatabase } from '../database/profile-state-database'
import '../database/profile-state-database-validation'
import {
  importProfileStateJson,
  readProfileStateParsedSnapshot,
  readProfileStateSnapshot,
  validateProfileStateSnapshot
} from './profile-state-documents'
import { hashProfileStatePayload as hashProfileStateJson } from './profile-state-document-validation'

const fixtures: { directory: string; db: ReturnType<typeof openProfileStateDatabase>['db'] }[] = []
afterEach(() => {
  for (const { directory, db } of fixtures.splice(0)) {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(source = '{"automationRuns":[{"id":"a"},{"id":"b"}],"last":null}') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-streamed-profile-'))
  const { db } = openProfileStateDatabase(join(directory, 'profile-state.db'), 'stream-test')
  fixtures.push({ directory, db })
  importProfileStateJson(db, source)
  return db
}

// SQLite 3.54 rejects ADD COLUMN rowid aliases; CREATE TABLE and older files still allow them.

const readers = [
  readProfileStateSnapshot,
  readProfileStateParsedSnapshot,
  validateProfileStateSnapshot
]

describe('complete streaming profile validation', () => {
  it('closes the ordered-history iterator when the inner lookup fails validation', () => {
    const db = fixture()
    const update = db.prepare(
      'UPDATE profile_state_automation_runs SET payload = ?, content_hash = ? WHERE ordinal = 1'
    )
    const invalid = '{"id":"wrong"}'
    update.run(invalid, hashProfileStateJson(invalid))
    for (const read of readers) {
      expect(() => read(db)).toThrow('identity is corrupt')
      expect(db.isTransaction).toBe(false)
    }
    const valid = '{"id":"b"}'
    update.run(valid, hashProfileStateJson(valid))
    expect(validateProfileStateSnapshot(db)).toBe(1)
  })
})
