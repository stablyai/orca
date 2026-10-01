import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportProfileStateJson,
  importProfileStateJson,
  readProfileStateDocuments,
  readProfileStateRevision
} from './profile-state-documents'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'
import {
  ProfileStateRevisionConflictError,
  writeProfileStateDomain,
  writeProfileStateDomains
} from './profile-state-domain-writes'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openTestDatabase(): ReturnType<typeof openProfileStateDatabase>['db'] {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-domain-write-'))
  temporaryDirectories.push(directory)
  return openProfileStateDatabase(profileStateDatabaseFile(directory), 'profile-a').db
}

describe('profile state dirty-domain writes', () => {
  it('retains logical history order when existing runs change position', () => {
    const db = openTestDatabase()
    const runs = [{ id: 'first' }, { id: 'second' }, { id: 'third' }] as const
    const reordered = [runs[2], runs[0], runs[1]]
    try {
      importProfileStateJson(db, JSON.stringify({ automationRuns: runs }))
      writeProfileStateDomain(db, {
        domain: 'automationRuns',
        payload: JSON.stringify(reordered),
        expectedRevision: 1
      })

      expect(
        db.prepare('SELECT run_id FROM profile_state_automation_runs ORDER BY rowid').all()
      ).toEqual(runs.map((run) => ({ run_id: run.id })))
      expect(JSON.parse(exportProfileStateJson(db)).automationRuns).toEqual(reordered)

      db.prepare('UPDATE profile_state_automation_runs SET ordinal = 0 WHERE run_id = ?').run(
        'first'
      )
      expect(() => exportProfileStateJson(db)).toThrow(
        'Normalized automationRuns ordering is corrupt'
      )
    } finally {
      db.close()
    }
  })

  it('updates automationRuns without rewriting unrelated domains', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(
        db,
        JSON.stringify({
          settings: { theme: 'dark' },
          automationRuns: [{ id: 'run-1', status: 'pending' }]
        }),
        { now: () => 100 }
      )
      const settingsBefore = readProfileStateDocuments(db).find(
        (document) => document.domain === 'settings'
      )

      const result = writeProfileStateDomain(db, {
        domain: 'automationRuns',
        payload: JSON.stringify([{ id: 'run-1', status: 'completed' }]),
        expectedRevision: 1,
        now: () => 200
      })

      expect(result).toEqual({ changed: true, revision: 2 })
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({
        settings: { theme: 'dark' },
        automationRuns: [{ id: 'run-1', status: 'completed' }]
      })
      expect(readProfileStateDocuments(db)).toEqual([
        expect.objectContaining({ domain: 'settings', revision: 1, updatedAt: 100 }),
        expect.objectContaining({ domain: 'automationRuns', revision: 2, updatedAt: 200 })
      ])
      const settingsAfter = readProfileStateDocuments(db).find(
        (document) => document.domain === 'settings'
      )
      expect(settingsAfter).toMatchObject({
        payload: settingsBefore?.payload,
        contentHash: settingsBefore?.contentHash,
        updatedAt: settingsBefore?.updatedAt
      })
    } finally {
      db.close()
    }
  })

  it('commits changed automation runs as rows without rewriting the legacy document blob', () => {
    const db = openTestDatabase()
    try {
      const fixtureRun = buildProfileStateCutoverFixture().automationRuns[0]
      if (!fixtureRun) {
        throw new Error('Expected automation run fixture')
      }
      const initialRuns = [
        { ...fixtureRun, id: 'run-1', status: 'pending' as const },
        { ...fixtureRun, id: 'run-2', status: 'completed' as const }
      ]
      importProfileStateJson(
        db,
        JSON.stringify({
          settings: { theme: 'dark' },
          automationRuns: initialRuns
        }),
        { now: () => 100 }
      )
      const legacyDocument = db
        .prepare('SELECT payload, content_hash FROM profile_state_documents WHERE domain = ?')
        .get('automationRuns')

      const result = writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [],
        automationRunsAfter: [{ ...initialRuns[0], status: 'dispatched' as const }, initialRuns[1]]
      })

      expect(result).toEqual({
        changed: true,
        revision: 2,
        changedDomains: ['automationRuns']
      })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM profile_state_automation_runs').get()
      ).toEqual({ count: 2 })
      expect(
        db
          .prepare('SELECT payload, content_hash FROM profile_state_documents WHERE domain = ?')
          .get('automationRuns')
      ).toEqual(legacyDocument)
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({
        settings: { theme: 'dark' },
        automationRuns: [{ ...initialRuns[0], status: 'dispatched' }, initialRuns[1]]
      })
    } finally {
      db.close()
    }
  })

  it('rolls back a direct automation-run delta and revision when normalized metadata rejects it', () => {
    const db = openTestDatabase()
    try {
      const fixtureRun = buildProfileStateCutoverFixture().automationRuns[0]
      if (!fixtureRun) {
        throw new Error('Expected automation run fixture')
      }
      const initialRuns = [{ ...fixtureRun, id: 'run-1', status: 'pending' as const }]
      importProfileStateJson(db, JSON.stringify({ automationRuns: initialRuns }), {
        now: () => 100
      })
      const normalizedRuns = [{ ...initialRuns[0], status: 'dispatched' as const }]
      expect(
        writeProfileStateDomains(db, {
          expectedRevision: 1,
          replacements: [],
          automationRunsAfter: normalizedRuns
        })
      ).toEqual({ changed: true, revision: 2, changedDomains: ['automationRuns'] })
      db.exec(
        `CREATE TRIGGER fail_profile_state_automation_run_delta
         BEFORE UPDATE ON profile_state_automation_runs_meta
         WHEN NEW.domain = 'automationRuns'
         BEGIN SELECT RAISE(ABORT, 'injected automation delta failure'); END`
      )

      expect(() =>
        writeProfileStateDomains(db, {
          expectedRevision: 2,
          replacements: [],
          automationRunsAfter: [{ ...normalizedRuns[0], status: 'completed' as const }]
        })
      ).toThrow('injected automation delta failure')
      db.exec('DROP TRIGGER fail_profile_state_automation_run_delta')
      expect(readProfileStateRevision(db)).toBe(2)
      expect(JSON.parse(exportProfileStateJson(db)).automationRuns).toEqual(normalizedRuns)
    } finally {
      db.close()
    }
  })

  it('fails closed when a normalized automation-run row is corrupt', () => {
    const db = openTestDatabase()
    try {
      const fixtureRun = buildProfileStateCutoverFixture().automationRuns[0]
      if (!fixtureRun) {
        throw new Error('Expected automation run fixture')
      }
      const runs = [{ ...fixtureRun, id: 'run-1', status: 'pending' as const }]
      importProfileStateJson(db, JSON.stringify({ automationRuns: runs }))
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [],
        automationRunsAfter: runs
      })
      db.prepare('UPDATE profile_state_automation_runs SET payload = ? WHERE run_id = ?').run(
        JSON.stringify({ ...runs[0], status: 'tampered' }),
        'run-1'
      )

      expect(() => exportProfileStateJson(db)).toThrow('Normalized automationRuns row is corrupt')
    } finally {
      db.close()
    }
  })

  it('retains unchanged run row revisions while updating the aggregate projection', () => {
    const db = openTestDatabase()
    try {
      const fixtureRuns = buildProfileStateCutoverFixture().automationRuns
      const first = fixtureRuns[0]
      if (!first) {
        throw new Error('Expected automation run fixture')
      }
      const initialRuns = [
        { ...first, id: 'run-1', status: 'pending' as const },
        { ...first, id: 'run-2', status: 'dispatched' as const }
      ]
      importProfileStateJson(db, JSON.stringify({ automationRuns: initialRuns }))
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [],
        automationRunsAfter: [{ ...initialRuns[0], status: 'completed' as const }, initialRuns[1]]
      })
      writeProfileStateDomains(db, {
        expectedRevision: 2,
        replacements: [],
        automationRunsAfter: [
          { ...initialRuns[0], status: 'dispatch_failed' as const },
          initialRuns[1]
        ]
      })

      expect(
        db
          .prepare('SELECT revision FROM profile_state_automation_runs WHERE run_id = ?')
          .get('run-2')
      ).toEqual({ revision: 1 })
      expect(readProfileStateRevision(db)).toBe(3)
      expect(JSON.parse(exportProfileStateJson(db)).automationRuns).toEqual([
        { ...initialRuns[0], status: 'dispatch_failed' },
        initialRuns[1]
      ])
    } finally {
      db.close()
    }
  })

  it('commits several changed domains at one shared revision', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(
        db,
        JSON.stringify({
          settings: { theme: 'dark' },
          automationRuns: [{ id: 'run-1', status: 'pending' }],
          ui: { activeView: 'terminal' }
        }),
        { now: () => 100 }
      )

      expect(
        writeProfileStateDomains(db, {
          expectedRevision: 1,
          replacements: [
            {
              domain: 'settings',
              payload: JSON.stringify({ theme: 'light' }),
              now: () => 200
            },
            {
              domain: 'automationRuns',
              payload: JSON.stringify([{ id: 'run-1', status: 'completed' }]),
              now: () => 201
            }
          ]
        })
      ).toEqual({
        changed: true,
        revision: 2,
        changedDomains: ['settings', 'automationRuns']
      })
      expect(readProfileStateRevision(db)).toBe(2)
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({
        settings: { theme: 'light' },
        automationRuns: [{ id: 'run-1', status: 'completed' }],
        ui: { activeView: 'terminal' }
      })
      expect(readProfileStateDocuments(db)).toEqual([
        expect.objectContaining({ domain: 'settings', revision: 2, updatedAt: 200 }),
        expect.objectContaining({ domain: 'automationRuns', revision: 2, updatedAt: 201 }),
        expect.objectContaining({ domain: 'ui', revision: 1, updatedAt: 100 })
      ])
    } finally {
      db.close()
    }
  })

  it('rolls back every domain when a later mutation fails', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(
        db,
        JSON.stringify({
          settings: { theme: 'dark' },
          automationRuns: [{ id: 'run-1', status: 'pending' }]
        }),
        { now: () => 100 }
      )
      db.exec(
        `CREATE TRIGGER fail_second_profile_state_domain_update
         BEFORE UPDATE ON profile_state_automation_runs_meta
         WHEN NEW.domain = 'automationRuns'
         BEGIN SELECT RAISE(ABORT, 'injected domain failure'); END`
      )

      expect(() =>
        writeProfileStateDomains(db, {
          expectedRevision: 1,
          replacements: [
            { domain: 'settings', payload: JSON.stringify({ theme: 'light' }) },
            {
              domain: 'automationRuns',
              payload: JSON.stringify([{ id: 'run-1', status: 'completed' }])
            }
          ]
        })
      ).toThrow('injected domain failure')
      db.exec('DROP TRIGGER fail_second_profile_state_domain_update')
      expect(readProfileStateRevision(db)).toBe(1)
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({
        settings: { theme: 'dark' },
        automationRuns: [{ id: 'run-1', status: 'pending' }]
      })
    } finally {
      db.close()
    }
  })

  it('fences a stale multi-domain transaction before changing either row', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(
        db,
        JSON.stringify({ settings: { theme: 'dark' }, ui: { activeView: 'terminal' } })
      )
      writeProfileStateDomain(db, {
        domain: 'settings',
        payload: JSON.stringify({ theme: 'light' }),
        expectedRevision: 1
      })

      expect(() =>
        writeProfileStateDomains(db, {
          expectedRevision: 1,
          replacements: [
            { domain: 'settings', payload: JSON.stringify({ theme: 'blue' }) },
            { domain: 'ui', payload: JSON.stringify({ activeView: 'browser' }) }
          ]
        })
      ).toThrowError(ProfileStateRevisionConflictError)
      expect(readProfileStateRevision(db)).toBe(2)
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({
        settings: { theme: 'light' },
        ui: { activeView: 'terminal' }
      })
    } finally {
      db.close()
    }
  })

  it('rejects duplicate domains before opening a transaction', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ settings: { theme: 'dark' } }))
      expect(() =>
        writeProfileStateDomains(db, {
          expectedRevision: 1,
          replacements: [
            { domain: 'settings', payload: JSON.stringify({ theme: 'light' }) },
            { domain: 'settings', payload: JSON.stringify({ theme: 'blue' }) }
          ]
        })
      ).toThrow('repeats domain: settings')
      expect(readProfileStateRevision(db)).toBe(1)
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({ settings: { theme: 'dark' } })
    } finally {
      db.close()
    }
  })

  it('fences a stale Store and leaves the database unchanged', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
      writeProfileStateDomain(db, {
        domain: 'automationRuns',
        payload: JSON.stringify([{ id: 'run-1', status: 'completed' }]),
        expectedRevision: 1
      })

      expect(() =>
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: JSON.stringify([{ id: 'run-1', status: 'failed' }]),
          expectedRevision: 1
        })
      ).toThrowError(
        expect.objectContaining({
          code: 'profile-state-revision-conflict',
          expectedRevision: 1,
          actualRevision: 2
        })
      )
      expect(readProfileStateRevision(db)).toBe(2)
      expect(JSON.parse(exportProfileStateJson(db)).automationRuns).toEqual([
        { id: 'run-1', status: 'completed' }
      ])
    } finally {
      db.close()
    }
  })

  it('fences two independently opened database writers with the shared revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-domain-writer-fence-'))
    temporaryDirectories.push(directory)
    const databasePath = profileStateDatabaseFile(directory)
    const first = openProfileStateDatabase(databasePath, 'profile-a').db
    const second = openProfileStateDatabase(databasePath, 'profile-a').db
    try {
      importProfileStateJson(first, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
      expect(readProfileStateRevision(second)).toBe(1)
      writeProfileStateDomain(first, {
        domain: 'automationRuns',
        payload: JSON.stringify([{ id: 'run-1', status: 'completed' }]),
        expectedRevision: 1
      })

      expect(() =>
        writeProfileStateDomain(second, {
          domain: 'automationRuns',
          payload: JSON.stringify([{ id: 'run-1', status: 'failed' }]),
          expectedRevision: 1
        })
      ).toThrowError(ProfileStateRevisionConflictError)
      expect(readProfileStateRevision(second)).toBe(2)
    } finally {
      first.close()
      second.close()
    }
  })

  it('does not advance revision for an identical replacement or absent delete', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
      expect(
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: JSON.stringify([{ id: 'run-1' }]),
          expectedRevision: 1
        })
      ).toEqual({ changed: false, revision: 1 })
      expect(
        writeProfileStateDomain(db, {
          domain: 'missingDomain',
          payload: null,
          expectedRevision: 1
        })
      ).toEqual({ changed: false, revision: 1 })
      expect(readProfileStateRevision(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('distinguishes explicit JSON null from deleting a domain', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
      expect(
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: 'null',
          expectedRevision: 1
        })
      ).toEqual({ changed: true, revision: 2 })
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({ automationRuns: null })

      expect(
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: null,
          expectedRevision: 2
        })
      ).toEqual({ changed: true, revision: 3 })
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({})
    } finally {
      db.close()
    }
  })

  it('rolls back the row and revision when SQLite rejects the replacement', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
      db.exec(
        `CREATE TRIGGER fail_profile_state_domain_update
         BEFORE UPDATE ON profile_state_automation_runs_meta
         WHEN NEW.domain = 'automationRuns'
         BEGIN SELECT RAISE(ABORT, 'injected domain failure'); END`
      )

      expect(() =>
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: JSON.stringify([{ id: 'run-1', status: 'failed' }]),
          expectedRevision: 1
        })
      ).toThrow('injected domain failure')
      db.exec('DROP TRIGGER fail_profile_state_domain_update')
      expect(readProfileStateRevision(db)).toBe(1)
      expect(JSON.parse(exportProfileStateJson(db))).toEqual({
        automationRuns: [{ id: 'run-1' }]
      })
    } finally {
      db.close()
    }
  })

  it('rejects malformed payloads before opening a transaction', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
      expect(() =>
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: '{invalid',
          expectedRevision: 1
        })
      ).toThrow('Profile state domain payload is invalid JSON: automationRuns')
      expect(readProfileStateRevision(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('fails closed when the target row hash is already corrupt', () => {
    const db = openTestDatabase()
    try {
      importProfileStateJson(db, JSON.stringify({ automationRuns: [{ id: 'run-1' }] }))
      db.prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?').run(
        JSON.stringify([{ id: 'tampered' }]),
        'automationRuns'
      )

      expect(() =>
        writeProfileStateDomain(db, {
          domain: 'automationRuns',
          payload: JSON.stringify([{ id: 'run-1', status: 'completed' }]),
          expectedRevision: 1
        })
      ).toThrow('Profile state document hash mismatch: automationRuns')
      expect(readProfileStateRevision(db)).toBe(1)
    } finally {
      db.close()
    }
  })
})
