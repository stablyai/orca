import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportProfileStateJson, importProfileStateJson } from './profile-state-documents'
import { readProfileStateRevision } from '../database/profile-state-revision'
import { openProfileStateDatabase } from '../database/profile-state-database'
import { profileStateDatabaseFile } from '../../../../shared/profile-state-storage-paths'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import { buildProfileStateCutoverFixture } from '../../profile-state-cutover-fixture'

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
})
