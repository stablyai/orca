import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateRevision,
  readProfileStateSnapshot
} from './profile-state-documents'
import { writeProfileStateDomains } from './profile-state-domain-writes'

const databases: { db: ReturnType<typeof openProfileStateDatabase>['db']; directory: string }[] = []

function fixture(value: unknown = { future: { content: '雪 🐋', nullable: null } }) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-domain-equality-'))
  const { db } = openProfileStateDatabase(join(directory, 'state.db'), 'profile')
  importProfileStateJson(db, JSON.stringify({ settings: {}, extension: value }))
  databases.push({ db, directory })
  return { db, payload: JSON.stringify(value) }
}

afterEach(() => {
  for (const { db, directory } of databases.splice(0)) {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('validated domain replacement equality', () => {
  it.each([{ nested: { content: '雪 🐋', nullable: null } }, null])(
    'preserves equal payload, revision and timestamp for %j',
    (value) => {
      const { db, payload } = fixture(value)
      const before = readProfileStateSnapshot(db)
      const rows = db.prepare('SELECT * FROM profile_state_documents').all()

      expect(
        writeProfileStateDomains(db, {
          expectedRevision: 1,
          replacements: [
            {
              domain: 'extension',
              payload,
              now: () => {
                throw new Error('An unchanged replacement must not request a timestamp')
              }
            }
          ]
        })
      ).toEqual({ changed: false, revision: 1, changedDomains: [] })
      expect(readProfileStateSnapshot(db)).toEqual(before)
      expect(db.prepare('SELECT * FROM profile_state_documents').all()).toEqual(rows)

      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [{ domain: 'extension', payload: null }]
      })
      expect(JSON.parse(readProfileStateSnapshot(db).json)).toEqual({ settings: {} })
    }
  )

  it.each([
    ["content_hash = 'invalid'", /metadata is invalid/],
    [`content_hash = '${'a'.repeat(64)}'`, /hash mismatch/],
    ['domain_version = 0', /metadata is invalid/],
    ['updated_at = -1', /metadata is invalid/],
    ['revision = 0', /metadata is invalid/],
    ['revision = 2', /exceeds profile revision/]
  ] as const)('rejects equal payload with corrupt %s', (assignment, error) => {
    const { db, payload } = fixture()
    db.exec(`UPDATE profile_state_documents SET ${assignment} WHERE domain = 'extension'`)
    const before = db.prepare('SELECT * FROM profile_state_documents').all()

    expect(() =>
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [
          { domain: 'settings', payload: '{"changed":true}' },
          { domain: 'extension', payload }
        ]
      })
    ).toThrow(error)
    expect(readProfileStateRevision(db)).toBe(1)
    expect(db.isTransaction).toBe(false)
    expect(db.prepare('SELECT * FROM profile_state_documents').all()).toEqual(before)
  })

  it.each(['{', '{"valid":true}', null])(
    'rejects malformed stored JSON with a matching hash on replacement %j',
    (payload) => {
      const { db } = fixture()
      db.prepare(
        "UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = 'extension'"
      ).run('{', hashProfileStateJson('{'))

      expect(() =>
        writeProfileStateDomains(db, {
          expectedRevision: 1,
          replacements: [{ domain: 'extension', payload }]
        })
      ).toThrow(/invalid JSON: extension/)
      expect(readProfileStateRevision(db)).toBe(1)
      expect(db.isTransaction).toBe(false)
      expect(
        db.prepare("SELECT payload FROM profile_state_documents WHERE domain = 'extension'").get()
      ).toEqual({ payload: '{' })
    }
  )

  it('fences a stale writer even when its payload remains equal', () => {
    const { db, payload } = fixture()
    writeProfileStateDomains(db, {
      expectedRevision: 1,
      replacements: [{ domain: 'settings', payload: '{"changed":true}' }]
    })
    const before = readProfileStateSnapshot(db)

    expect(() =>
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [{ domain: 'extension', payload }]
      })
    ).toThrow(expect.objectContaining({ code: 'profile-state-revision-conflict' }))
    expect(readProfileStateSnapshot(db)).toEqual(before)
  })
})
