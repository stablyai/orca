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
import * as database from './profile-state-database'
import { profileProjectMoveIntentPath } from '../../orca-profiles/profile-project-move-record'
import { hashProfileStatePayload } from './profile-state-document-validation'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import { rollbackProfileState } from './profile-state-recovery-command'
import { ProfileStateRecoveryRequiredError } from './profile-state-recovery-required'
import { formatProfileStateStartupFailure } from './profile-state-startup-failure'
import {
  profileStateRecoveryRequestSchema,
  profileStateRecoveryResponseSchema,
  type ProfileStateRecoverySelector
} from '../../../shared/profile-state-recovery-command'

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

/** A profile with a backup at revision 1, then newer saves to two sections at revision 2. */
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
  it.each([
    {
      section: 'repos',
      damage:
        'UPDATE profile_state_documents SET payload = \'["a","b","c"]\' WHERE domain = \'repos\'',
      repaired: { repos: ['a'], ui: { width: 2 }, automationRuns: [{ id: 'r1', n: 1 }] }
    },
    {
      section: 'automationRuns',
      damage: `UPDATE profile_state_automation_runs SET payload = '{"id":"r1","n":9}' WHERE run_id = 'r1'`,
      repaired: { repos: ['a', 'b'], ui: { width: 2 }, automationRuns: [{ id: 'r1', n: 1 }] }
    },
    ...[
      "updated_at = 'broken'",
      "revision = '999999999999999999999x'",
      'revision = 2.5',
      'revision = -1',
      "revision = X'33'"
    ].map((metadata) => ({
      section: 'repos',
      damage: `UPDATE profile_state_documents SET ${metadata} WHERE domain = 'repos'`,
      repaired: { repos: ['a'], ui: { width: 2 }, automationRuns: [{ id: 'r1', n: 1 }] }
    })),
    ...['__proto__', ''].map((section) => ({
      section,
      damage: `UPDATE profile_state_documents SET payload = '{}' WHERE domain = '${section}'`,
      repaired: {
        [section]: { saved: true },
        repos: ['a', 'b'],
        ui: { width: 2 },
        automationRuns: [{ id: 'r1', n: 1 }]
      }
    }))
  ])(
    'replaces only damaged $section from a backup and keeps newer intact sections',
    async ({ section, damage, repaired }) => {
      const profile = await profileWithNewerSaves(
        section === '__proto__' || section === '' ? { [section]: { saved: true } } : {}
      )
      withDatabase(profile.databaseFile, (db) => db.exec(damage))
      const damagedBytes = readFileSync(profile.databaseFile)

      const failure = startupFailure(profile)
      expect(failure.message).toContain(
        section === 'repos'
          ? 'Projects'
          : section === 'automationRuns'
            ? 'Automation history'
            : 'Other saved app state'
      )
      expect(failure.repairableSections).toEqual([
        { domain: section, backupId: profile.backupId, backupCreatedAtMs: expect.any(Number) }
      ])
      expect(formatProfileStateStartupFailure(failure)).toContain(
        `orca profile state rollback --repair --profile-id ${profileId}`
      )

      expect(() =>
        rollback(profile, { kind: 'repair', sections: [{ domain: section, backupId: null }] })
      ).toThrow('changed since you chose')
      expect(readFileSync(profile.databaseFile)).toEqual(damagedBytes)

      const request = profileStateRecoveryRequestSchema.parse({
        userDataPath: profile.root,
        profileId,
        selector: { kind: 'repair', sections: [{ domain: section, backupId: profile.backupId }] }
      })
      const result = rollback(profile, request.selector)
      expect(
        profileStateRecoveryResponseSchema.parse(JSON.parse(JSON.stringify({ ok: true, result })))
      ).toEqual({ ok: true, result })
      expect(result).toMatchObject({ storage: 'sqlite', revision: 3, removedDatabaseFiles: [] })
      expect(result.repairedSections).toEqual(failure.repairableSections)
      expect(readFileSync(join(result.quarantineDirectory, 'profile-state.db'))).toEqual(
        damagedBytes
      )

      const reopened = bootstrapProfileStateAuthority(profile)
      try {
        expect(JSON.parse(reopened.authority?.readSerializedState() ?? 'null')).toEqual(repaired)
      } finally {
        reopened.authority?.close()
      }
    }
  )

  it.each([
    "UPDATE profile_state_meta SET value = '1' WHERE key = 'revision'",
    "DELETE FROM profile_state_meta WHERE key = 'revision'",
    "UPDATE profile_state_documents SET revision = 3, payload = 'bad' WHERE domain = 'repos'",
    "UPDATE profile_state_documents SET payload = 'bad' WHERE domain = 'repos'; UPDATE profile_state_documents SET revision = 3 WHERE domain = 'ui'",
    'UPDATE profile_state_automation_runs SET revision = 3',
    "INSERT INTO profile_state_automation_runs SELECT 'r2', 1, payload, content_hash, 3, updated_at FROM profile_state_automation_runs; UPDATE profile_state_automation_runs SET payload = 'bad' WHERE run_id = 'r1'",
    'UPDATE profile_state_automation_runs_meta SET revision = 3'
  ])(
    'keeps revision ambiguity on whole-file recovery regardless of payload faults: %s',
    async (damage) => {
      const profile = await profileWithNewerSaves()
      withDatabase(profile.databaseFile, (db) => db.exec(damage))
      const before = readFileSync(profile.databaseFile)
      expect(startupFailure(profile).repairableSections).toBeUndefined()
      expect(() => rollback(profile, { kind: 'repair' })).toThrow(
        "Orca can't repair this profile one section at a time"
      )
      expect(readFileSync(profile.databaseFile)).toEqual(before)
    }
  )

  it.each(['pending', 'unreadable', 'no-root'])(
    'does not offer a repair without move admission: %s',
    async (kind) => {
      const profile = await profileWithNewerSaves()
      withDatabase(profile.databaseFile, (db) =>
        db.exec("UPDATE profile_state_documents SET payload = 'bad' WHERE domain = 'repos'")
      )
      if (kind !== 'no-root') {
        const id = '11111111-1111-1111-1111-111111111111'
        mkdirSync(join(profile.root, 'profile-move-intents'))
        const hash = hashProfileStatePayload('{}')
        writeFileSync(
          profileProjectMoveIntentPath(profile.root, id),
          kind === 'unreadable'
            ? 'bad'
            : JSON.stringify({
                version: 1,
                id,
                sourceProfileId: profileId,
                targetProfileId: 'other',
                expectedSourceRevision: 2,
                expectedTargetRevision: 0,
                sourceBeforeHash: hash,
                targetBeforeHash: hash,
                sourceAfterHash: hash,
                targetAfterHash: hash,
                sourceAfterJson: '{}',
                targetAfterJson: '{}'
              })
        )
      }
      const before = readFileSync(profile.databaseFile)
      const failure = startupFailure({
        ...profile,
        userDataPath: kind === 'no-root' ? undefined : profile.root
      })
      expect(failure.repairableSections).toBeUndefined()
      expect(failure.message).not.toContain('--repair')
      if (kind !== 'no-root') {
        expect(() => rollback(profile, { kind: 'repair' })).toThrow('pending project move')
      }
      expect(readFileSync(profile.databaseFile)).toEqual(before)
    }
  )

  it('resolves independent sources and absence newest-first, opening each candidate once', async () => {
    const profile = await profileWithNewerSaves({ absent: true })
    const newest = createProfileStateDatabaseBackupId(Date.now())
    const newestPath = profileStateDatabaseBackupPath(profile.databaseFile, newest)
    await writeProfileStateBackup({
      databasePath: profile.databaseFile,
      profileId,
      targetPath: newestPath
    })
    withDatabase(newestPath, (db) => {
      db.exec("DELETE FROM profile_state_documents WHERE domain = 'absent'")
      db.exec("UPDATE profile_state_documents SET payload = 'bad' WHERE domain = 'ui'")
    })
    withDatabase(profile.databaseFile, (db) => {
      writeProfileStateDomains(db, {
        expectedRevision: 2,
        replacements: [{ domain: 'automationRuns', payload: '[{"id":"r1","n":2}]' }]
      })
      db.exec("UPDATE profile_state_documents SET payload = 'bad' WHERE domain IN ('absent', 'ui')")
      db.prepare(
        "UPDATE profile_state_documents SET payload = 'bad', content_hash = ? WHERE domain = 'repos'"
      ).run(hashProfileStatePayload('["a"]'))
    })
    const backupPaths = [
      newestPath,
      profileStateDatabaseBackupPath(profile.databaseFile, profile.backupId)
    ]
    const observations: { path: string; close: () => void }[] = []
    const open = database.openProfileStateDatabaseReadOnly
    vi.spyOn(database, 'openProfileStateDatabaseReadOnly').mockImplementation((...args) => {
      const opened = open(...args)
      if (backupPaths.includes(args[0])) {
        observations.push({ path: args[0], close: vi.spyOn(opened.db, 'close') })
      }
      return opened
    })
    const sections = startupFailure(profile).repairableSections
    expect(sections).toEqual([
      { domain: 'absent', backupId: newest, backupCreatedAtMs: expect.any(Number) },
      { domain: 'repos', backupId: newest, backupCreatedAtMs: expect.any(Number) },
      { domain: 'ui', backupId: profile.backupId, backupCreatedAtMs: expect.any(Number) }
    ])
    expect(observations.map(({ path }) => path)).toEqual(backupPaths)
    const result = rollback(profile, { kind: 'repair', sections: sections && [...sections] })
    expect(result.repairedSections).toEqual(sections)
    expect(observations.map(({ path }) => path)).toEqual([...backupPaths, ...backupPaths])
    for (const { close } of observations) {
      expect(close).toHaveBeenCalledTimes(1)
    }
    const reopened = bootstrapProfileStateAuthority(profile)
    try {
      expect(JSON.parse(reopened.authority?.readSerializedState() ?? 'null')).toEqual({
        repos: ['a', 'b'],
        ui: { width: 1 },
        automationRuns: [{ id: 'r1', n: 2 }]
      })
    } finally {
      reopened.authority?.close()
    }
  })
})
