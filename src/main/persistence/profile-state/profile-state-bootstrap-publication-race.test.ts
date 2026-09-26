import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import { migrateProfileStateToSqlite } from './profile-state-migration'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { profileStateJsonExportPath } from './profile-state-export-path'
import type { ProfileStateAuthority } from '../loading-store/profile-state-authority'
import { formatProfileStateStartupFailure } from './profile-state-startup-failure'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
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
  it.each(['empty', 'legacy'])(
    'explains unavailable hard links without publishing a partial %s database',
    (kind) => {
      const root = fs.mkdtempSync(join(tmpdir(), 'orca-bootstrap-no-hardlinks-'))
      roots.push(root)
      const options = {
        dataFile: join(root, 'orca-data.json'),
        databaseFile: join(root, 'profile-state.db'),
        profileId: 'unsupported-publication',
        allowEmptyProfileState: true
      }
      const json = '{"settings":{"theme":"dark"}}'
      if (kind === 'legacy') {
        fs.writeFileSync(options.dataFile, json)
      }
      const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error('hard links unsupported'), {
          code: 'ENOTSUP',
          syscall: 'link'
        })
      })
      let failure: unknown
      try {
        bootstrapProfileStateAuthority(options)
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ code: 'profile-state-publication-unavailable' })
      const message = formatProfileStateStartupFailure(failure)
      expect(message).toContain('hard links')
      expect(message).toContain(root)
      expect(message).toContain('complete Orca data directory')
      expect(message).not.toContain('rollback')
      expect(fs.existsSync(options.databaseFile)).toBe(false)
      expect(fs.readdirSync(root)).toEqual(kind === 'legacy' ? ['orca-data.json'] : [])
      if (kind === 'legacy') {
        expect(fs.readFileSync(options.dataFile, 'utf8')).toBe(json)
      }
      link.mockRestore()
      const retry = bootstrapProfileStateAuthority(options)
      expect(retry.authority).toBeDefined()
      if (retry.authority) {
        authorities.push(retry.authority)
      }
    }
  )

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

  it.each(['empty', 'legacy'])('cannot replace an acknowledged competing %s profile', (kind) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'orca-bootstrap-publication-race-'))
    roots.push(root)
    const options = {
      dataFile: join(root, 'orca-data.json'),
      databaseFile: join(root, 'profile-state.db'),
      profileId: 'publication-race',
      allowEmptyProfileState: true
    }
    if (kind === 'legacy') {
      fs.writeFileSync(options.dataFile, '{"settings":{"theme":"dark"}}')
    }
    const committed = {
      settings: { theme: 'light' },
      extension: { acknowledged: true, value: null }
    }
    let competing = false
    const open = () => {
      const result = bootstrapProfileStateAuthority(options)
      if (result.authority) {
        authorities.push(result.authority)
      }
      return result
    }
    const race = (target: fs.PathLike) => {
      if (competing || target !== options.databaseFile) {
        return
      }
      competing = true
      const winner = open().authority
      if (!winner) {
        throw new Error('Competing startup did not establish SQLite')
      }
      winner.writeSerializedState(Buffer.from(JSON.stringify(committed)))
      expect(JSON.parse(winner.readSerializedState() ?? 'null')).toEqual(committed)
      winner.close?.()
      authorities.splice(authorities.indexOf(winner), 1)
    }
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      race(to)
      rename(from, to)
    })
    const link = fs.linkSync
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      race(to)
      link(from, to)
    })

    let publicationError: unknown
    try {
      open()
    } catch (error) {
      publicationError = error
    }
    expect(competing).toBe(true)
    expect(JSON.parse(open().authority?.readSerializedState() ?? 'null')).toEqual(committed)
    expect(publicationError).toMatchObject({ message: expect.stringContaining('storage changed') })
    expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})
