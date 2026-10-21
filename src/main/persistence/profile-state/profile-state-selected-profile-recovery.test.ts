import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireProfileStateMaintenance } from './profile-state-access'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import { getProfileStateExports, rollbackProfileState } from './profile-state-recovery-command'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-selected-profile-'))
  roots.push(root)
  const indexPath = join(root, 'orca-profile-index.json')
  writeFileSync(
    indexPath,
    JSON.stringify({ activeProfileId: 'active', profiles: [{ id: 'active' }, { id: 'inactive' }] })
  )
  const profiles = ['active', 'inactive'].map((profileId) => {
    const directory = join(root, 'profiles', profileId)
    mkdirSync(directory, { recursive: true })
    const dataFile = join(directory, 'orca-data.json')
    const databaseFile = join(directory, 'profile-state.db')
    const legacy = JSON.stringify({ settings: { theme: 'legacy' } })
    writeFileSync(dataFile, legacy)
    const { authority } = migrateProfileStateToSqlite({
      profileId,
      dataFile,
      databaseFile,
      expectedLegacyJson: legacy,
      serializedState: legacy
    })
    authority.writeSerializedState(Buffer.from(JSON.stringify({ settings: { theme: profileId } })))
    authority.close()
    return { profileId, dataFile, databaseFile }
  })
  const active = profiles[0]
  const inactive = profiles[1]
  return { root, indexPath, active, inactive }
}

describe('explicit profile recovery selection', () => {
  it('downgrades an inactive profile from its latest SQLite state without changing the active profile', () => {
    const f = fixture()
    const activeBytes = readFileSync(f.active.databaseFile)
    const indexBytes = readFileSync(f.indexPath, 'utf8')
    const markerPath = join(f.root, 'http1-compatibility.json')
    writeFileSync(markerPath, 'active-marker')
    const maintenance = acquireProfileStateMaintenance(f.root)
    try {
      const result = rollbackProfileState(f.root, { kind: 'latest-json' }, maintenance, 'inactive')
      expect(result.profileId).toBe('inactive')
      expect(JSON.parse(readFileSync(f.inactive.dataFile, 'utf8'))).toEqual({
        settings: { theme: 'inactive' }
      })
      expect(existsSync(f.inactive.databaseFile)).toBe(false)
      expect(existsSync(`${f.inactive.databaseFile}.authority`)).toBe(false)
    } finally {
      maintenance.release()
    }
    expect(readFileSync(f.active.databaseFile).equals(activeBytes)).toBe(true)
    expect(readFileSync(f.indexPath, 'utf8')).toBe(indexBytes)
    expect(readFileSync(markerPath, 'utf8')).toBe('active-marker')
    const reopened = bootstrapProfileStateAuthority(f.inactive)
    expect(reopened.migrated).toBe(true)
    reopened.authority?.close()
  })

  it('refuses unknown and escaping IDs without falling back to the active profile', () => {
    const f = fixture()
    const before = readFileSync(f.active.databaseFile)
    for (const id of ['missing', '../active']) {
      expect(() => getProfileStateExports(f.root, id)).toThrow('Could not resolve')
    }
    expect(readFileSync(f.active.databaseFile).equals(before)).toBe(true)
  })
})
