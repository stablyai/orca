import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import '../database/profile-state-database'
import { profileStateDatabaseFile } from '../../../../shared/profile-state-storage-paths'

import '../documents/profile-state-document-validation'

import { bootstrapProfileStateAuthority as bootstrapProfileStateAuthorityImpl } from './profile-state-authority-bootstrap'
import { classifyProfileStateStorage } from '../database/profile-state-storage-classification'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('encrypted:'.length)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

const temporaryDirectories: string[] = []
const authoritiesToClose: NonNullable<
  ReturnType<typeof bootstrapProfileStateAuthorityImpl>['authority']
>[] = []

function bootstrapProfileStateAuthority(
  options: Parameters<typeof bootstrapProfileStateAuthorityImpl>[0]
): ReturnType<typeof bootstrapProfileStateAuthorityImpl> {
  const result = bootstrapProfileStateAuthorityImpl(options)
  if (result.authority !== undefined) {
    authoritiesToClose.push(result.authority)
  }
  return result
}

afterEach(() => {
  for (const authority of authoritiesToClose.splice(0)) {
    authority.close?.()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function createDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-profile-state-bootstrap-'))
  temporaryDirectories.push(root)
  const directory = join(root, 'profiles', 'profile-bootstrap-test')
  mkdirSync(directory, { recursive: true })
  return directory
}

function paths(directory: string): {
  dataFile: string
  databaseFile: string
  profileId: string
} {
  return {
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: profileStateDatabaseFile(directory),
    profileId: 'profile-bootstrap-test'
  }
}

describe('profile state authority bootstrap', () => {
  it('cleans failed empty-profile initialization before a successful retry', () => {
    const directory = createDirectory()
    const options = { ...paths(directory), allowEmptyProfileState: true }
    const initializationFailure = new Error('injected initial schema failure')
    const originalExec = Database.prototype.exec
    const execSpy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database,
      sql
    ) {
      originalExec.call(this, sql)
      if (sql.includes('CREATE TABLE')) {
        const row = this.prepare('PRAGMA database_list').get()
        if (typeof row?.file !== 'string') {
          throw new Error('Expected a file-backed database during initialization')
        }
        expect(existsSync(`${row.file}-journal`)).toBe(true)
        for (const suffix of ['-wal', '-shm']) {
          writeFileSync(`${row.file}${suffix}`, 'interrupted schema initialization')
        }
        throw initializationFailure
      }
    })

    expect(() => bootstrapProfileStateAuthority(options)).toThrowError(
      expect.objectContaining({ cause: initializationFailure })
    )
    expect(existsSync(options.databaseFile)).toBe(false)
    expect(classifyProfileStateStorage(options.dataFile, options.databaseFile)).toBe('neither')
    expect(readdirSync(directory)).toEqual([])

    execSpy.mockRestore()
    const retry = bootstrapProfileStateAuthority(options)
    expect(retry.migrated).toBe(false)
    expect(retry.authority).toBeDefined()
    expect(retry.authority?.readSerializedState()).toBeUndefined()
    expect(bootstrapProfileStateAuthority(options).classification).toBe('sqlite-only')
  })

  it('preserves JSON created while an empty database is being initialized', () => {
    const options = { ...paths(createDirectory()), allowEmptyProfileState: true }
    const source = '{"settings":{"theme":"dark"}}'
    const originalClose = Database.prototype.close
    vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (this: Database) {
      originalClose.call(this)
      writeFileSync(options.dataFile, source)
    })

    expect(() => bootstrapProfileStateAuthority(options)).toThrow(
      'Profile state storage changed while creating an empty database'
    )
    expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
    expect(readdirSync(dirname(options.dataFile))).toEqual(['orca-data.json'])
  })
})
