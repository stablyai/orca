import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readAcceptedProfileStateParsedSnapshot,
  readProfileStateDocuments,
  readProfileStateParsedSnapshot,
  readProfileStateSnapshot,
  validateProfileStateSnapshot
} from './profile-state-documents'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-parsed-profile-'))
  directories.push(directory)
  return openProfileStateDatabase(join(directory, 'profile-state.db'), 'parsed-profile').db
}

describe('checked profile state values', () => {
  it.each([
    [
      'row hash',
      "UPDATE profile_state_automation_runs SET payload = '{}' WHERE ordinal = 0",
      'row is corrupt'
    ],
    [
      'ordering',
      'UPDATE profile_state_automation_runs SET ordinal = 3 WHERE ordinal = 0',
      'ordering is corrupt'
    ],
    [
      'revision',
      'UPDATE profile_state_automation_runs SET revision = 99 WHERE ordinal = 0',
      'metadata is inconsistent'
    ],
    [
      'timestamp',
      'UPDATE profile_state_automation_runs SET updated_at = updated_at + 1 WHERE ordinal = 0',
      'metadata is inconsistent'
    ]
  ])('rejects corrupt normalized %s in both representations', (_, sql, message) => {
    const db = fixture()
    try {
      importProfileStateJson(db, '{"automationRuns":[{"id":"a"},{"id":"b"}]}')
      db.exec(sql)
      expect(() => readProfileStateParsedSnapshot(db)).toThrow(message)
      expect(() => readProfileStateSnapshot(db)).toThrow(message)
      expect(() => validateProfileStateSnapshot(db)).toThrow(message)
    } finally {
      db.close()
    }
  })

  it('rejects a normalized identity mismatch even when the payload hash is valid', () => {
    const db = fixture()
    try {
      importProfileStateJson(db, '{"automationRuns":[{"id":"a"}]}')
      const payload = '{"id":"other"}'
      db.prepare('UPDATE profile_state_automation_runs SET payload = ?, content_hash = ?').run(
        payload,
        hashProfileStateJson(payload)
      )
      expect(() => readProfileStateParsedSnapshot(db)).toThrow('identity is corrupt')
      expect(() => readProfileStateSnapshot(db)).toThrow('identity is corrupt')
      expect(() => validateProfileStateSnapshot(db)).toThrow('identity is corrupt')
    } finally {
      db.close()
    }
  })

  it.each([
    undefined,
    null,
    [],
    [
      { id: 'second', unknown: '雪 🐋\ud800' },
      { id: 'first', unknown: null }
    ],
    { futureHistoryFormat: true },
    [{ id: 'duplicate' }, { id: 'duplicate' }]
  ])('matches serialized semantics for history %j', (automationRuns) => {
    const db = fixture()
    try {
      const source = JSON.stringify(
        Object.fromEntries([
          ['z', { sealed: 'safeStorage:unchanged' }],
          ['__proto__', { own: true }],
          ['10', 'ten'],
          ['2', 'two'],
          ['constructor', 'own constructor'],
          ['automationRuns', automationRuns],
          ['a', null]
        ])
      )
      importProfileStateJson(db, source, { acceptedLegacyJsonHash: hashProfileStateJson(source) })
      const serialized = readProfileStateSnapshot(db)
      const expected: unknown = JSON.parse(serialized.json)
      const parsed = readProfileStateParsedSnapshot(db)
      expect(parsed).toStrictEqual({ revision: serialized.revision, state: expected })
      expect(Object.keys(parsed.state)).toEqual(Object.keys(JSON.parse(source)))
      expect(Object.hasOwn(parsed.state, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(parsed.state)).toBe(Object.prototype)
      expect(readAcceptedProfileStateParsedSnapshot(db, source)).toStrictEqual(parsed)
      expect(readAcceptedProfileStateParsedSnapshot(db, '{}')).toBeUndefined()
      expect(
        readProfileStateDocuments(db).every((document) => !Object.hasOwn(document, 'value'))
      ).toBe(true)
      expect(readProfileStateSnapshot(db).json).toBe(serialized.json)
    } finally {
      db.close()
    }
  })

  it('validates original bytes while reusing noncanonical JSON values', () => {
    const db = fixture()
    try {
      importProfileStateJson(db, '{"future":null,"automationRuns":[{"id":"a"},{"id":"b"}]}')
      const future =
        ' {"negativeZero":-0,"large":1e400,"duplicate":1,"duplicate":2,"text":"雪\\ud800"} '
      db.prepare(
        'UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?'
      ).run(future, hashProfileStateJson(future), 'future')
      const payloads = [' {"id":"a","number":-0,"large":1e400} ', '{"id":"b","text":"雪\\ud800"}']
      for (const [ordinal, payload] of payloads.entries()) {
        db.prepare(
          'UPDATE profile_state_automation_runs SET payload = ?, content_hash = ? WHERE ordinal = ?'
        ).run(payload, hashProfileStateJson(payload), ordinal)
      }
      const aggregate = `[${payloads.join(',')}]`
      db.prepare('UPDATE profile_state_automation_runs_meta SET content_hash = ?').run(
        hashProfileStateJson(aggregate)
      )
      const serialized = readProfileStateSnapshot(db)
      expect(serialized.json).toBe(`{"future":${future},"automationRuns":${aggregate}}`)
      expect(readProfileStateParsedSnapshot(db)).toStrictEqual({
        revision: serialized.revision,
        state: JSON.parse(serialized.json)
      })
      db.prepare('UPDATE profile_state_automation_runs_meta SET content_hash = ?').run(
        hashProfileStateJson(JSON.stringify(JSON.parse(aggregate)))
      )
      expect(() => readProfileStateParsedSnapshot(db)).toThrow('aggregate hash mismatch')
      expect(() => readProfileStateSnapshot(db)).toThrow('aggregate hash mismatch')
    } finally {
      db.close()
    }
  })
})
