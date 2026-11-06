import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireProfileStateMaintenance } from './profile-state-access'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from './profile-state-backup-path'
import { writeProfileStateBackup } from './profile-state-backup-job'
import { openWritableProfileStateDatabase } from './profile-state-database'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import { rollbackProfileState } from './profile-state-recovery-command'
import { ProfileStateRecoveryRequiredError } from './profile-state-recovery-required'
import type { ProfileStateRecoverySelector } from '../../../shared/profile-state-recovery-command'

const roots: string[] = []
const profileId = 'section-repair'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function profileWithNewerSaves(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-section-repair-'))
  roots.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = join(directory, 'profile-state.db')
  const initialJson = JSON.stringify({
    ...extra,
    repos: ['a'],
    ui: { width: 1 },
    automationRuns: [{ id: 'r1', n: 1 }]
  })
  writeFileSync(dataFile, initialJson)
  migrateProfileStateToSqlite({
    dataFile,
    databaseFile,
    profileId,
    expectedLegacyJson: initialJson,
    serializedState: initialJson
  }).authority.close()
  const backupId = createProfileStateDatabaseBackupId(Date.now() - 60_000)
  await writeProfileStateBackup({
    databasePath: databaseFile,
    profileId,
    targetPath: profileStateDatabaseBackupPath(databaseFile, backupId)
  })
  withDatabase(databaseFile, (db) =>
    writeProfileStateDomains(db, {
      expectedRevision: 1,
      replacements: [
        { domain: 'repos', payload: JSON.stringify(['a', 'b']) },
        { domain: 'ui', payload: JSON.stringify({ width: 2 }) }
      ]
    })
  )
  return { root, userDataPath: root, dataFile, databaseFile, profileId, backupId }
}

function withDatabase<T>(
  databaseFile: string,
  write: (db: ReturnType<typeof openWritableProfileStateDatabase>['db']) => T
): T {
  const opened = openWritableProfileStateDatabase(databaseFile, profileId)
  try {
    return write(opened.db)
  } finally {
    opened.db.close()
  }
}

function startupFailure(profile: Parameters<typeof bootstrapProfileStateAuthority>[0]) {
  try {
    bootstrapProfileStateAuthority(profile).authority?.close()
  } catch (error) {
    if (error instanceof ProfileStateRecoveryRequiredError) {
      return error
    }
    throw error
  }
  throw new Error('expected the profile to need recovery')
}

function rollback(
  profile: Awaited<ReturnType<typeof profileWithNewerSaves>>,
  selector: ProfileStateRecoverySelector
) {
  const maintenance = acquireProfileStateMaintenance(profile.root)
  try {
    return rollbackProfileState(profile.root, selector, maintenance)
  } finally {
    maintenance.release()
  }
}

describe('repairing damaged profile-state sections', () => {
  it('refuses to replace newly damaged history under a keep-current approval', async () => {
    const profile = await profileWithNewerSaves()
    withDatabase(profile.databaseFile, (db) =>
      db.exec(
        "UPDATE profile_state_documents SET content_hash = 'broken' WHERE domain = 'automationRuns'"
      )
    )
    const approved = startupFailure(profile).repairableSections
    expect(approved).toEqual([{ domain: 'automationRuns', source: 'current' }])
    withDatabase(profile.databaseFile, (db) =>
      db.exec("UPDATE profile_state_automation_runs_meta SET content_hash = 'broken'")
    )
    const damagedBytes = readFileSync(profile.databaseFile)
    expect(() =>
      rollback(profile, { kind: 'repair', sections: approved && [...approved] })
    ).toThrow('changed since you chose')
    expect(readFileSync(profile.databaseFile)).toEqual(damagedBytes)
  })

  it('repairs malformed normalized history metadata from the approved backup', async () => {
    const profile = await profileWithNewerSaves()
    withDatabase(profile.databaseFile, (db) =>
      db.exec("UPDATE profile_state_automation_runs_meta SET content_hash = 'broken'")
    )
    const damagedBytes = readFileSync(profile.databaseFile)
    const failure = startupFailure(profile)
    expect(failure.repairableSections).toEqual([
      {
        domain: 'automationRuns',
        backupId: profile.backupId,
        backupCreatedAtMs: expect.any(Number)
      }
    ])

    expect(() =>
      rollback(profile, {
        kind: 'repair',
        sections: [{ domain: 'automationRuns', backupId: null }]
      })
    ).toThrow('changed since you chose')
    expect(readFileSync(profile.databaseFile)).toEqual(damagedBytes)

    const result = rollback(profile, {
      kind: 'repair',
      sections: failure.repairableSections && [...failure.repairableSections]
    })
    expect(readFileSync(join(result.quarantineDirectory, 'profile-state.db'))).toEqual(damagedBytes)
    const reopened = bootstrapProfileStateAuthority(profile)
    try {
      expect(JSON.parse(reopened.authority?.readSerializedState() ?? 'null')).toEqual({
        repos: ['a', 'b'],
        ui: { width: 2 },
        automationRuns: [{ id: 'r1', n: 1 }]
      })
    } finally {
      reopened.authority?.close()
    }
  })
})
