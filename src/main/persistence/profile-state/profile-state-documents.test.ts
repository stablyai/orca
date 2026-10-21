import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildProfileStateCutoverFixture,
  canonicalProfileStateJson
} from '../profile-state-cutover-fixture'
import {
  exportProfileStateJson,
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateJsonAcceptance,
  readProfileStateDocuments,
  readProfileStateRevision,
  readProfileStateSnapshot,
  readProfileStateParsedSnapshot
} from './profile-state-documents'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'
import { readProfileStateDomains } from './profile-state-domain-reader'
import { writeProfileStateDomain } from './profile-state-domain-writes'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openTestDatabase(): {
  directory: string
  db: ReturnType<typeof openProfileStateDatabase>['db']
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-documents-'))
  temporaryDirectories.push(directory)
  return {
    directory,
    db: openProfileStateDatabase(profileStateDatabaseFile(directory), 'profile-a').db
  }
}

describe('profile state document adapter', () => {
  it('round-trips every top-level domain, including unknown keys, nulls, arrays, and sealed bytes', () => {
    const { db } = openTestDatabase()
    try {
      const fixture = buildProfileStateCutoverFixture()
      const raw = JSON.stringify(fixture)
      expect(importProfileStateJson(db, raw, { now: () => 123 })).toBe(1)
      const exported = exportProfileStateJson(db)

      expect(canonicalProfileStateJson(JSON.parse(exported))).toBe(
        canonicalProfileStateJson(fixture)
      )
      expect(JSON.parse(exported).settings.opencodeSessionCookie).toBe(
        fixture.settings.opencodeSessionCookie
      )
      expect(readProfileStateRevision(db)).toBe(1)
      expect(readProfileStateDocuments(db)).toHaveLength(Object.keys(fixture).length)
      expect(readProfileStateDocuments(db).find((row) => row.domain === 'settings')).toMatchObject({
        revision: 1,
        updatedAt: 123
      })
    } finally {
      db.close()
    }
  })

  it('preserves missing domains versus explicit null values and array order', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(
        db,
        JSON.stringify({
          explicitNull: null,
          ordered: ['first', 'second'],
          unknown: { keep: true }
        })
      )
      const exported = JSON.parse(exportProfileStateJson(db))
      expect(exported).toEqual({
        explicitNull: null,
        ordered: ['first', 'second'],
        unknown: { keep: true }
      })
      expect(Object.hasOwn(exported, 'missing')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('advances revision and replaces the complete document set atomically', () => {
    const { db } = openTestDatabase()
    try {
      expect(importProfileStateJson(db, JSON.stringify({ first: 1, old: 2 }))).toBe(1)
      expect(importProfileStateJson(db, JSON.stringify({ second: 3 }), { now: () => 456 })).toBe(2)
      expect(exportProfileStateJson(db)).toBe(JSON.stringify({ second: 3 }))
      expect(readProfileStateRevision(db)).toBe(2)
      expect(readProfileStateDocuments(db)[0]).toMatchObject({
        domain: 'second',
        revision: 2,
        updatedAt: 456
      })
    } finally {
      db.close()
    }
  })

  it('rejects a stale complete-document replacement before deleting rows', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ keep: true }))
      expect(() =>
        importProfileStateJson(db, JSON.stringify({ replacement: true }), {
          expectedRevision: 0
        })
      ).toThrowError(
        expect.objectContaining({
          code: 'profile-state-revision-conflict',
          expectedRevision: 0,
          actualRevision: 1
        })
      )
      expect(exportProfileStateJson(db)).toBe(JSON.stringify({ keep: true }))
      expect(readProfileStateRevision(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('commits the legacy JSON acceptance marker with the imported revision', () => {
    const { db } = openTestDatabase()
    try {
      const raw = JSON.stringify({ settings: { theme: 'dark' } })
      expect(
        importProfileStateJson(db, raw, {
          acceptedLegacyJsonHash: hashProfileStateJson(raw),
          now: () => 123
        })
      ).toBe(1)
      expect(readProfileStateJsonAcceptance(db)).toEqual({
        jsonHash: hashProfileStateJson(raw),
        acceptedRevision: 1
      })
    } finally {
      db.close()
    }
  })

  it('rolls back every row and the revision when one insert fails', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ keep: { value: 1 } }), { now: () => 10 })
      db.exec(
        `CREATE TRIGGER fail_profile_state_insert
         BEFORE INSERT ON profile_state_documents
         WHEN NEW.domain = 'second'
         BEGIN SELECT RAISE(ABORT, 'injected document failure'); END`
      )

      expect(() => importProfileStateJson(db, JSON.stringify({ first: 1, second: 2 }))).toThrow(
        'injected document failure'
      )
      db.exec('DROP TRIGGER fail_profile_state_insert')
      expect(exportProfileStateJson(db)).toBe(JSON.stringify({ keep: { value: 1 } }))
      expect(readProfileStateRevision(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('does not roll back a transaction owned by the caller', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ keep: true }))
      db.exec('BEGIN IMMEDIATE')

      expect(() => importProfileStateJson(db, JSON.stringify({ replacement: true }))).toThrow(
        'requires an idle database connection'
      )
      expect(db.isTransaction).toBe(true)
      db.exec('ROLLBACK')
      expect(exportProfileStateJson(db)).toBe(JSON.stringify({ keep: true }))
    } finally {
      if (db.isTransaction) {
        db.exec('ROLLBACK')
      }
      db.close()
    }
  })

  it('rejects a tampered payload when its hash no longer matches', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ ui: { active: 'terminal' } }))
      db.prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?').run(
        JSON.stringify({ active: 'tasks' }),
        'ui'
      )

      expect(() => readProfileStateDocuments(db)).toThrowError(
        expect.objectContaining({ domain: 'ui' })
      )
      expect(() => exportProfileStateJson(db)).toThrowError(/hash mismatch: ui/)
    } finally {
      db.close()
    }
  })

  it('rejects invalid domain JSON even when its hash is correct', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ settings: { theme: 'dark' } }))
      db.prepare(
        'UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?'
      ).run('{invalid', hashProfileStateJson('{invalid'), 'settings')

      expect(() => readProfileStateDocuments(db)).toThrow(/invalid JSON: settings/)
      expect(() => readProfileStateSnapshot(db)).toThrow(/invalid JSON: settings/)
      expect(() => readProfileStateParsedSnapshot(db)).toThrow(/invalid JSON: settings/)
    } finally {
      db.close()
    }
  })

  it.each(['[]', ' null '])(
    'rejects the noncanonical normalized history placeholder %s',
    (payload) => {
      const { db } = openTestDatabase()
      try {
        const original = {
          settings: { theme: 'dark' },
          automationRuns: [{ id: 'run-1', status: 'pending' }],
          ui: { sidebarWidth: 280 }
        }
        importProfileStateJson(db, JSON.stringify(original))
        expect(
          db
            .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
            .get('automationRuns')
        ).toEqual({ payload: 'null' })
        expect(readProfileStateSnapshot(db).json).toBe(JSON.stringify(original))
        db.prepare(
          'UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?'
        ).run(payload, hashProfileStateJson(payload), 'automationRuns')
        expect(() => readProfileStateSnapshot(db)).toThrow(/placeholder is invalid/)
        expect(() => readProfileStateParsedSnapshot(db)).toThrow(/placeholder is invalid/)
      } finally {
        db.close()
      }
    }
  )

  it('rejects a retained legacy document whose revision is ahead of the profile', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
      db.prepare('UPDATE profile_state_documents SET revision = ? WHERE domain = ?').run(
        999,
        'automationRuns'
      )

      expect(() => readProfileStateDocuments(db)).toThrow(
        /document revision 999 exceeds profile revision 1/
      )
      expect(() => readProfileStateParsedSnapshot(db)).toThrow(
        /document revision 999 exceeds profile revision 1/
      )
    } finally {
      db.close()
    }
  })

  it.each(['null', 'absent'] as const)(
    'rejects normalized %s metadata whose revision is ahead of the profile',
    (presence) => {
      const { directory, db } = openTestDatabase()
      try {
        importProfileStateJson(db, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: presence === 'null' ? 'null' : null,
          expectedRevision: 1
        })
        expect(db.prepare('SELECT presence FROM profile_state_automation_runs_meta').get()).toEqual(
          {
            presence
          }
        )
        db.prepare('UPDATE profile_state_automation_runs_meta SET revision = ?').run(999)

        expect(() => readProfileStateSnapshot(db)).toThrow(
          /document revision 999 exceeds profile revision 2/
        )
        expect(() => readProfileStateParsedSnapshot(db)).toThrow(
          /document revision 999 exceeds profile revision 2/
        )
        expect(
          readProfileStateDomains(profileStateDatabaseFile(directory), 'profile-a', [
            'automationRuns'
          ])
        ).toMatchObject({
          kind: 'unreadable'
        })
      } finally {
        db.close()
      }
    }
  )

  it.each(['missing', 'absent', 'null'] as const)(
    'rejects %s automation metadata with remaining normalized runs on every read path',
    (presence) => {
      const { directory, db } = openTestDatabase()
      try {
        importProfileStateJson(
          db,
          JSON.stringify({ automationRuns: [{ id: 'run-1', status: 'pending' }] })
        )
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: JSON.stringify([{ id: 'run-1', status: 'completed' }]),
          expectedRevision: 1
        })
        expect(JSON.parse(readProfileStateSnapshot(db).json)).toEqual({
          automationRuns: [{ id: 'run-1', status: 'completed' }]
        })
        if (presence === 'missing') {
          db.exec('DELETE FROM profile_state_automation_runs_meta')
        } else {
          db.prepare(
            'UPDATE profile_state_automation_runs_meta SET presence = ?, content_hash = ?'
          ).run(presence, presence === 'absent' ? '' : hashProfileStateJson('null'))
        }

        const expectedError =
          presence === 'missing'
            ? 'Normalized automationRuns metadata is malformed'
            : 'Normalized automationRuns rows exist for an empty domain'
        expect(() => readProfileStateSnapshot(db)).toThrow(expectedError)
        expect(() => readProfileStateParsedSnapshot(db)).toThrow(expectedError)
        const databasePath = profileStateDatabaseFile(directory)
        const authority = new ProfileStateSqliteAuthority(databasePath, 'profile-a')
        expect(() => authority.readSerializedState()).toThrow(
          presence === 'missing' ? /Unable to read profile state database/ : expectedError
        )
        expect(
          readProfileStateDomains(databasePath, 'profile-a', ['automationRuns'])
        ).toMatchObject({
          kind: 'unreadable'
        })
      } finally {
        db.close()
      }
    }
  )

  it('rejects malformed input without changing an existing revision', () => {
    const { db } = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ keep: true }))
      expect(() => importProfileStateJson(db, '{invalid')).toThrow('Profile state JSON is invalid')
      expect(exportProfileStateJson(db)).toBe(JSON.stringify({ keep: true }))
      expect(readProfileStateRevision(db)).toBe(1)
    } finally {
      db.close()
    }
  })
})
