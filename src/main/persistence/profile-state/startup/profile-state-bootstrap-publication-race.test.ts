import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './profile-state-authority-bootstrap'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import { ProfileStateSqliteAuthority } from '../profile-state-sqlite-authority'
import { profileStateJsonExportPath } from '../legacy-json/profile-state-export-path'
import type { ProfileStateAuthority } from '../../loading-store/profile-writing/profile-state-authority'
import './profile-state-startup-failure'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock('../../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const roots: string[] = []
const authorities: ProfileStateAuthority[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const authority of authorities.splice(0)) {
    authority.close?.()
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('first database publication with competing startup', () => {
  it('names its migration export after the snapshot actually captured', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'orca-migration-export-race-'))
    roots.push(root)
    const options = {
      dataFile: join(root, 'orca-data.json'),
      databaseFile: join(root, 'profile-state.db'),
      profileId: 'migration-export-race',
      expectedLegacyJson: '{"settings":{"theme":"dark"}}',
      serializedState: '{"settings":{"theme":"dark"}}'
    }
    fs.writeFileSync(options.dataFile, options.expectedLegacyJson)
    const link = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      link(from, to)
      if (to === options.databaseFile) {
        const peer = new ProfileStateSqliteAuthority(options.databaseFile, options.profileId)
        try {
          peer.writeSerializedDomains([{ domain: 'settings', payload: '{"theme":"light"}' }])
        } finally {
          peer.close()
        }
      }
    })

    const migrated = migrateProfileStateToSqlite(options)
    authorities.push(migrated.authority)
    expect(migrated.authority.revision).toBe(2)
    expect(fs.existsSync(profileStateJsonExportPath(options.dataFile, 1))).toBe(false)
    expect(
      JSON.parse(fs.readFileSync(profileStateJsonExportPath(options.dataFile, 2), 'utf8'))
    ).toEqual({
      settings: { theme: 'light' }
    })
    expect(fs.readFileSync(options.dataFile, 'utf8')).toBe(options.expectedLegacyJson)
  })
})
