import { build } from 'esbuild'
import type * as WorkerEntryPath from '../../../worker-threads/worker-thread-entry-path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createProfileStateStoreForStartup,
  ProfileStateStartupAuthorityError
} from './profile-state-startup-authority'
import '../database/profile-state-database'
import { profileStateDatabaseFile } from '../../../../shared/profile-state-storage-paths'

const bundle = vi.hoisted(() => ({ directory: '' }))
vi.mock('../../../worker-threads/worker-thread-entry-path', async (importOriginal) => {
  const original = await importOriginal<typeof WorkerEntryPath>()
  return {
    ...original,
    resolveWorkerThreadEntryPath: (
      layout: Parameters<typeof original.resolveWorkerThreadEntryPath>[0],
      name: string
    ) =>
      name.startsWith('profile-state-')
        ? join(bundle.directory, name)
        : original.resolveWorkerThreadEntryPath(layout, name)
  }
})

beforeAll(async () => {
  bundle.directory = mkdtempSync(join(tmpdir(), 'orca-startup-writers-'))
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/writer/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/backup/profile-state-backup-worker-entry.ts')
    ],
    entryNames: '[name]',
    outdir: bundle.directory,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})
afterAll(() => rmSync(bundle.directory, { recursive: true, force: true }))

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

vi.mock('../../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('profile-state startup authority boundary', () => {
  it('leaves legacy JSON untouched when the runtime cannot own SQLite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-orcad-node18-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databaseFile = profileStateDatabaseFile(directory)
    const source = JSON.stringify({ settings: { theme: 'dark' } })
    writeFileSync(dataFile, source)
    const original = process.getBuiltinModule
    vi.spyOn(process, 'getBuiltinModule').mockImplementation((id) =>
      id === 'node:sqlite' ? undefined : original(id)
    )

    await expect(
      createProfileStateStoreForStartup({
        dataFile,
        databaseFile,
        profileId: 'orcad-node18-test',
        runtime: 'orcad',
        storageAuthority: 'runtime'
      })
    ).rejects.toThrowError(ProfileStateStartupAuthorityError)

    expect(readFileSync(dataFile, 'utf8')).toBe(source)
    expect(existsSync(databaseFile)).toBe(false)
  })
})
