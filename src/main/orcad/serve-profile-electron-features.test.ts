import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES } from '../../shared/ephemeral-vm-runtime-store'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../shared/profile-state-storage-paths'
import {
  serveProfileHasEphemeralVmRuntimes,
  serveProfileHasInstalledPlugins,
  serveProfileHasSshTargets
} from './serve-profile-electron-features'

const TARGET = { id: 'ssh-1', label: 'box', host: 'box.example', port: 22, username: 'me' }
let userData = ''

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-serve-profile-features-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

function writeIndex(profileId: string): void {
  writeFileSync(
    join(userData, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
}

function writeSqliteProfile(profileId: string, state: Record<string, unknown>): void {
  mkdirSync(join(userData, 'profiles', profileId), { recursive: true })
  const opened = openProfileStateDatabase(
    getOrcaProfileStateDatabaseFile(profileId, userData),
    profileId
  )
  importProfileStateJson(opened.db, JSON.stringify(state))
  opened.db.close()
}

describe('serveProfileHasSshTargets', () => {
  it('is false for a fresh install', () => {
    expect(serveProfileHasSshTargets(userData)).toBe(false)
  })

  it('reads the active SQLite profile', () => {
    writeIndex('work')
    writeSqliteProfile('work', { sshTargets: [TARGET] })
    expect(serveProfileHasSshTargets(userData)).toBe(true)
  })

  it('is false for an active SQLite profile with no targets', () => {
    writeIndex('work')
    writeSqliteProfile('work', { sshTargets: [], settings: {} })
    expect(serveProfileHasSshTargets(userData)).toBe(false)
  })

  it('reads an active JSON-only profile', () => {
    writeIndex('work')
    mkdirSync(join(userData, 'profiles', 'work'), { recursive: true })
    writeFileSync(
      getOrcaProfileDataFile('work', userData),
      JSON.stringify({ sshTargets: [TARGET] })
    )
    expect(serveProfileHasSshTargets(userData)).toBe(true)
  })

  it('reads the legacy root profile when there is no profile index', () => {
    writeFileSync(join(userData, 'orca-data.json'), JSON.stringify({ sshTargets: [TARGET] }))
    expect(serveProfileHasSshTargets(userData)).toBe(true)
  })

  it('throws on a JSON-only profile whose root is not an object', () => {
    for (const root of ['null', '[]']) {
      writeFileSync(join(userData, 'orca-data.json'), root)
      expect(() => serveProfileHasSshTargets(userData)).toThrow(/not an object/)
    }
  })
})

describe('serveProfileHasInstalledPlugins', () => {
  function writePlugin(dirName: string, { pointer }: { pointer: boolean }): void {
    const pluginDir = join(userData, 'plugins', dirName)
    mkdirSync(pluginDir, { recursive: true })
    if (pointer) {
      writeFileSync(join(pluginDir, 'current'), 'a'.repeat(64))
    }
  }

  it('is false without a plugins directory', () => {
    expect(serveProfileHasInstalledPlugins(userData)).toBe(false)
  })

  it('finds a published install, with or without a lockfile', () => {
    writePlugin('acme.recipes', { pointer: true })
    expect(serveProfileHasInstalledPlugins(userData)).toBe(true)
  })

  it('ignores staging leftovers, data and lockfile-only state', () => {
    writePlugin('acme.recipes', { pointer: false })
    writePlugin('not-a-plugin-key', { pointer: true })
    writeFileSync(join(userData, 'plugins', 'plugins.lock.json'), '{"version":1,"plugins":{}}')
    expect(serveProfileHasInstalledPlugins(userData)).toBe(false)
  })

  it('counts saved dev plugin paths in a JSON-only profile', () => {
    writeIndex('work')
    mkdirSync(join(userData, 'profiles', 'work'), { recursive: true })
    writeFileSync(
      getOrcaProfileDataFile('work', userData),
      JSON.stringify({ settings: { devPluginPaths: ['/dev/acme-plugin'] } })
    )
    expect(serveProfileHasInstalledPlugins(userData)).toBe(true)
  })

  it('counts saved dev plugin paths in SQLite settings', () => {
    writeIndex('work')
    writeSqliteProfile('work', { settings: { devPluginPaths: ['/dev/acme-plugin'] } })
    expect(serveProfileHasInstalledPlugins(userData)).toBe(true)
  })

  it('ignores empty dev plugin paths', () => {
    writeIndex('work')
    writeSqliteProfile('work', { settings: { devPluginPaths: [] } })
    expect(serveProfileHasInstalledPlugins(userData)).toBe(false)
    writeIndex('json')
    mkdirSync(join(userData, 'profiles', 'json'), { recursive: true })
    writeFileSync(
      getOrcaProfileDataFile('json', userData),
      JSON.stringify({ settings: { devPluginPaths: [] } })
    )
    expect(serveProfileHasInstalledPlugins(userData)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws when the plugins directory cannot be listed',
    () => {
      mkdirSync(join(userData, 'plugins'), { mode: 0o000 })
      try {
        expect(() => serveProfileHasInstalledPlugins(userData)).toThrow(/EACCES/)
      } finally {
        chmodSync(join(userData, 'plugins'), 0o700)
      }
    }
  )
})

function vmRecord(id: string, status: string): Record<string, unknown> {
  return {
    id,
    recipeId: 'controller-vm',
    status,
    cleanupStatus: status === 'cleaned' ? 'succeeded' : 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: { label: 'vm', host: '127.0.0.1', port: 22, username: 'dev' }
      }
    }
  }
}

describe('serveProfileHasEphemeralVmRuntimes', () => {
  const storePath = (): string => join(userData, 'orca-ephemeral-vm-runtimes.json')
  const writeStore = (runtimes: unknown[], version = 1): void =>
    writeFileSync(storePath(), JSON.stringify({ version, runtimes }))

  it('is false without a store or with no records', () => {
    expect(serveProfileHasEphemeralVmRuntimes(userData)).toBe(false)
    writeStore([])
    expect(serveProfileHasEphemeralVmRuntimes(userData)).toBe(false)
  })

  it('finds a live record and ignores destroyed ones', () => {
    writeStore([vmRecord('vm-1', 'cleaned')])
    expect(serveProfileHasEphemeralVmRuntimes(userData)).toBe(false)
    writeStore([vmRecord('vm-1', 'cleaned'), vmRecord('vm-2', 'suspended')])
    expect(serveProfileHasEphemeralVmRuntimes(userData)).toBe(true)
  })

  it('throws on an invalid or oversized store', () => {
    writeFileSync(storePath(), '{"version":1}')
    expect(() => serveProfileHasEphemeralVmRuntimes(userData)).toThrow()
    const live = JSON.stringify({ version: 1, runtimes: [vmRecord('vm-1', 'running')] })
    writeFileSync(storePath(), live.padEnd(MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES + 1))
    expect(() => serveProfileHasEphemeralVmRuntimes(userData)).toThrow(/too large/)
  })

  // The store's own reader rejects these, so they must not read as "nothing live".
  it('throws on a store its reader would reject, even when every record looks cleaned', () => {
    writeStore([], 2)
    expect(() => serveProfileHasEphemeralVmRuntimes(userData)).toThrow()
    writeStore([{ id: 'vm-1', status: 'cleaned' }])
    expect(() => serveProfileHasEphemeralVmRuntimes(userData)).toThrow()
  })

  // A FIFO with no writer would block the probe; a non-regular path must be refused before it is opened.
  it('refuses a store path that is not a regular file', () => {
    mkdirSync(storePath())
    expect(() => serveProfileHasEphemeralVmRuntimes(userData)).toThrow(/regular file/)
  })
})
