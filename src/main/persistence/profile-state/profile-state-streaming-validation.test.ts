import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROFILE_STATE_AUTOMATION_RUNS_TABLE } from './profile-state-automation-runs-model'
import { openProfileStateDatabase } from './profile-state-database'
import { verifyProfileStateSchema } from './profile-state-database-validation'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateParsedSnapshot,
  readProfileStateSnapshot,
  validateProfileStateSnapshot
} from './profile-state-documents'

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
function shadowRowidAliases(db: ReturnType<typeof fixture>): void {
  const table = PROFILE_STATE_AUTOMATION_RUNS_TABLE
  const schema = db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(table)?.sql
  if (typeof schema !== 'string') {
    throw new Error(`missing ${table} schema`)
  }
  const columns = 'run_id, ordinal, payload, content_hash, revision, updated_at'
  const shadows = ['rowid', '_rowid_', 'oid'].map((name) => `${name} TEXT DEFAULT 'shadow'`)
  db.exec(`ALTER TABLE ${table} RENAME TO legacy_runs;
    ${schema.replace(/\)\s*$/, `, ${shadows.join(', ')})`)};
    INSERT INTO ${table}(${columns}) SELECT ${columns} FROM legacy_runs;
    DROP TABLE legacy_runs;`)
}

const readers = [
  readProfileStateSnapshot,
  readProfileStateParsedSnapshot,
  validateProfileStateSnapshot
]

describe('complete streaming profile validation', () => {
  it('preserves history order and bytes with rowids at both SQLite integer limits', () => {
    const source =
      '{"before":null,"automationRuns":[{"id":"a","text":"雪\\ud800"},{"id":"b"}],"after":true}'
    const db = fixture(source)
    const before = readProfileStateSnapshot(db)
    const update = db.prepare('UPDATE profile_state_automation_runs SET rowid = ? WHERE run_id = ?')
    update.run(9223372036854775807n, 'a')
    update.run(-9223372036854775808n, 'b')
    expect(readProfileStateSnapshot(db)).toEqual(before)
    expect(readProfileStateParsedSnapshot(db)).toEqual({
      revision: before.revision,
      state: JSON.parse(source)
    })
    expect(validateProfileStateSnapshot(db)).toBe(before.revision)
    expect(db.isTransaction).toBe(false)
  })

  it('accepts extra columns that shadow every SQLite rowid alias', () => {
    const db = fixture()
    const before = readProfileStateSnapshot(db)
    shadowRowidAliases(db)
    expect(
      db.prepare('SELECT rowid, _rowid_, oid FROM profile_state_automation_runs').get()
    ).toEqual({
      rowid: 'shadow',
      _rowid_: 'shadow',
      oid: 'shadow'
    })
    verifyProfileStateSchema(db, 'stream-test')
    expect(readProfileStateSnapshot(db)).toEqual(before)
    expect(readProfileStateParsedSnapshot(db).state).toEqual(JSON.parse(before.json))
    expect(validateProfileStateSnapshot(db)).toBe(before.revision)
  })

  it.each([
    '{}',
    '{"automationRuns":null}',
    '{"automationRuns":[]}',
    '{"automationRuns":{"future":true}}'
  ])('validates history presence without constructing a returned state: %s', (source) => {
    const db = fixture(source)
    expect(validateProfileStateSnapshot(db)).toBe(readProfileStateSnapshot(db).revision)
    expect(readProfileStateParsedSnapshot(db).state).toEqual(JSON.parse(source))
  })

  it.each([
    [
      'row hash',
      "UPDATE profile_state_automation_runs SET content_hash = printf('%064d', 0) WHERE ordinal = 1"
    ],
    ['ordering', 'UPDATE profile_state_automation_runs SET ordinal = 0 WHERE ordinal = 1'],
    ['row revision', 'UPDATE profile_state_automation_runs SET revision = 99 WHERE ordinal = 1'],
    [
      'row timestamp',
      'UPDATE profile_state_automation_runs SET updated_at = updated_at + 1 WHERE ordinal = 1'
    ],
    [
      'aggregate hash',
      "UPDATE profile_state_automation_runs_meta SET content_hash = printf('%064d', 0)"
    ],
    ['domain hash', "UPDATE profile_state_documents SET payload = 'true' WHERE domain = 'last'"],
    ['domain revision', "UPDATE profile_state_documents SET revision = 99 WHERE domain = 'last'"]
  ])('rejects late %s corruption in every representation', (_, sql) => {
    const db = fixture()
    db.exec(sql)
    for (const read of readers) {
      expect(() => read(db)).toThrow()
      expect(db.isTransaction).toBe(false)
    }
  })

  it.each([false, true])(
    'closes failed iterators while preserving caller transaction ownership (%s)',
    (ownsTransaction) => {
      const db = fixture()
      if (ownsTransaction) {
        db.exec('BEGIN')
      }
      const payload = 'null,"injected":true'
      const update = db.prepare(
        'UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?'
      )
      update.run(payload, hashProfileStateJson(payload), 'last')
      expect(() => validateProfileStateSnapshot(db)).toThrow('invalid JSON')
      expect(db.isTransaction).toBe(ownsTransaction)
      update.run('null', hashProfileStateJson('null'), 'last')
      expect(validateProfileStateSnapshot(db)).toBe(1)
      expect(db.isTransaction).toBe(ownsTransaction)
      if (ownsTransaction) {
        db.exec('ROLLBACK')
      }
      expect(readProfileStateSnapshot(db).json).toBe(
        '{"automationRuns":[{"id":"a"},{"id":"b"}],"last":null}'
      )
    }
  )

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
