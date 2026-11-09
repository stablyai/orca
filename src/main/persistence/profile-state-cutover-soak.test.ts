import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProfileStateCutoverFixture } from './profile-state-cutover-fixture'
import type { ProfileStateOfflineLocation } from './profile-state/profile-state-offline-settings'
import {
  createProfileStateStore,
  type ProfileStateStoreFactoryOptions,
  type ProfileStateStoreFactoryResult
} from './profile-state/profile-state-store-factory'
import { profileStateDatabaseFile } from './profile-state/profile-state-database'

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

vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
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

type MigratedProfile = {
  options: ProfileStateStoreFactoryOptions
  location: ProfileStateOfflineLocation
  first: ProfileStateStoreFactoryResult
}

function createProfile(profileId: string, theme: string): MigratedProfile {
  const directory = mkdtempSync(join(tmpdir(), `orca-profile-state-cutover-${profileId}-`))
  temporaryDirectories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = profileStateDatabaseFile(directory)
  const fixture = buildProfileStateCutoverFixture(directory)
  writeFileSync(
    dataFile,
    JSON.stringify({
      ...fixture,
      settings: { ...fixture.settings, theme },
      // Unrelated payload makes complete-document commit costs meaningful.
      soakExtension: { bytes: 'x'.repeat(96 * 1024), nullable: null }
    })
  )
  const options: ProfileStateStoreFactoryOptions = {
    dataFile,
    databaseFile,
    profileId
  }
  const first = createProfileStateStore(options)
  expect(first.backend).toBe('sqlite')
  expect(first.migrated).toBe(true)
  return {
    options,
    location: { dataFile, databaseFile, profileId },
    first
  }
}

function removeLegacyJson(profile: MigratedProfile): void {
  profile.first.store.freezeWrites()
  rmSync(profile.options.dataFile, { force: true })
  expect(existsSync(profile.options.dataFile)).toBe(false)
  expect(existsSync(profile.options.databaseFile)).toBe(true)
}

function reopen(profile: MigratedProfile): ProfileStateStoreFactoryResult {
  return createProfileStateStore(profile.options)
}

describe('profile-state candidate cutover soak', () => {
  it('allows one stale complete-document writer and rejects the rest', () => {
    const profile = createProfile('soak-cas', 'light')
    removeLegacyJson(profile)
    const staleWriters = Array.from({ length: 7 }, () => reopen(profile))

    for (const [index, writer] of staleWriters.entries()) {
      writer.store.updateSettings({
        theme: index % 2 === 0 ? 'dark' : 'light',
        terminalFontSize: 100 + index
      })
    }

    let commits = 0
    let conflicts = 0
    for (const writer of staleWriters) {
      try {
        writer.store.flushOrThrow()
        commits += 1
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'profile-state-revision-conflict'
        ) {
          conflicts += 1
        } else {
          throw error
        }
      } finally {
        writer.store.freezeWrites()
      }
    }

    expect(commits).toBe(1)
    expect(conflicts).toBe(staleWriters.length - 1)
    const verifier = reopen(profile)
    expect(verifier.store.getSettings().terminalFontSize).toBe(100)
    expect(verifier.store.getSettings().opencodeSessionCookie).toBe('fixture-secret')
    expect(verifier.store.getWorkspaceSession('ssh:build-host').activeTabId).toBe('tab-remote')
    expect(readFileSync(profile.options.databaseFile)).toBeTruthy()
    verifier.store.freezeWrites()
  })
})
