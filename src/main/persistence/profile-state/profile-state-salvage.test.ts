import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import { importProfileStateJson } from './profile-state-documents'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from './profile-state-backup-path'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
import { acquireProfileStateMaintenance } from './profile-state-access'
import { salvageValidDocuments } from './profile-state-salvage'
import {
  rollbackProfileState,
  type ProfileStateRecoverySelector
} from './profile-state-recovery-command'

const roots: string[] = []
const profileId = 'salvage-recovery-test'
// Two domains: `settings` is the corrupt row, `ui` the one that survives.
const baselineJson = JSON.stringify({
  settings: { theme: 'dark' },
  ui: { unknownField: { keep: true } }
})
// Advanced one revision; the merge brings the newer `ui` back onto the restored
// baseline but NOT the corrupt `settings`.
const advancedJson = JSON.stringify({
  settings: { theme: 'light', addedLater: true },
  ui: { unknownField: { keep: true }, laterWork: 'recovered' }
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// A live SQLite primary damaged while a good revision-1 backup remains, and the
// profile registered in the index so rollback can find its active location.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-salvage-'))
  roots.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = join(directory, 'profile-state.db')

  const source = openProfileStateDatabase(databaseFile, profileId)
  try {
    importProfileStateJson(source.db, baselineJson) // revision 1
    const backupId = createProfileStateDatabaseBackupId()
    const backupPath = profileStateDatabaseBackupPath(databaseFile, backupId)
    await writeProfileStateDatabaseSnapshotAsync(source.db, backupPath)

    // Advance the live primary to revision 2, then break one row's hash so the
    // whole-snapshot validation fails while `ui` still verifies.
    importProfileStateJson(source.db, advancedJson)
    source.db.exec(
      "UPDATE profile_state_documents SET payload = '{}' WHERE domain = 'settings'"
    )
    return { root, dataFile, databaseFile, backupId }
  } finally {
    source.db.close()
  }
}

function selector(backupId: string): ProfileStateRecoverySelector {
  return { kind: 'sqlite', backupId }
}

function payloadOf(domain: string, databaseFile: string): unknown {
  const opened = openProfileStateDatabase(databaseFile, profileId)
  try {
    const row = opened.db
      .prepare('SELECT payload FROM profile_state_documents WHERE domain = ?')
      .get(domain) as { payload: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.payload)
  } finally {
    opened.db.close()
  }
}

describe('salvageValidDocuments', () => {
  it('keeps only the rows whose stored hash still verifies', async () => {
    const { databaseFile } = await fixture()
    const result = salvageValidDocuments({ databasePath: databaseFile, profileId })
    expect(result.skippedDomains).toEqual(['settings'])
    expect(result.intactDocuments.map((doc) => doc.domain)).toEqual(['ui'])
    expect(result.sourceRevision).toBe(2)
  })

  it('filters to the requested domains when given', async () => {
    const { databaseFile } = await fixture()
    const result = salvageValidDocuments({
      databasePath: databaseFile,
      profileId,
      domains: ['settings']
    })
    expect(result.intactDocuments).toEqual([])
    expect(result.skippedDomains).toEqual(['settings'])
  })
})

describe('rollbackProfileState with a quarantined salvage source', () => {
  it('restores the good backup then merges the surviving newer documents back', async () => {
    const { root, databaseFile, backupId } = await fixture()
    const maintenance = acquireProfileStateMaintenance(root)
    let result: ReturnType<typeof rollbackProfileState>
    try {
      result = rollbackProfileState(root, selector(backupId), maintenance, profileId)
    } finally {
      maintenance.release()
    }
    // The baseline is revision 1; the merge advances it to 2 because the
    // quarantined family carried a valid newer `ui` document.
    expect(result.revision).toBe(2)
    expect(result.storage).toBe('sqlite')
    expect(payloadOf('ui', databaseFile)).toMatchObject({ laterWork: 'recovered' })
    // Corrupt settings stays at the baseline value, not the quarantined one.
    expect(payloadOf('settings', databaseFile)).toEqual({ theme: 'dark' })
  })

  it('leaves the baseline untouched when salvage finds no intact document', async () => {
    const { root, databaseFile, backupId } = await fixture()
    // Corrupt the only surviving domain too, so salvage has nothing above the
    // baseline to merge back.
    const live = openProfileStateDatabase(databaseFile, profileId)
    try {
      live.db.exec(
        "UPDATE profile_state_documents SET payload = 'corrupt' WHERE domain = 'ui'"
      )
    } finally {
      live.db.close()
    }
    const maintenance = acquireProfileStateMaintenance(root)
    let result: ReturnType<typeof rollbackProfileState>
    try {
      result = rollbackProfileState(root, selector(backupId), maintenance, profileId)
    } finally {
      maintenance.release()
    }
    // Nothing to merge: revision stays at the restored baseline of 1.
    expect(result.revision).toBe(1)
    expect(payloadOf('settings', databaseFile)).toEqual({ theme: 'dark' })
  })
})
