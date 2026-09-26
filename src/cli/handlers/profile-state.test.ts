import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as durableFileWrite from '../../main/durable-file-write'
import * as http1Marker from '../../main/startup/http1-compatibility-marker'
import { readPersistedHttp1CompatibilityMode } from '../../main/startup/http1-compatibility-profile-state'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly,
  profileStateDatabaseFile
} from '../../main/persistence/profile-state/profile-state-database'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../../main/persistence/profile-state/profile-state-documents'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from '../../main/persistence/profile-state/profile-state-backup-path'
import { writeProfileStateDatabaseSnapshotAsync } from '../../main/persistence/profile-state/profile-state-database-snapshot'
import { profileStateJsonExportPath } from '../../main/persistence/profile-state/legacy-json/profile-state-export-path'
import { main } from '../index'

const { getCliStatusMock, getDefaultUserDataPathMock, runtimeClientConstructorMock } = vi.hoisted(
  () => ({
    getCliStatusMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(),
    runtimeClientConstructorMock: vi.fn()
  })
)

vi.mock('../runtime-client', () => {
  class RuntimeClientError extends Error {
    readonly code: string
    readonly data: unknown

    constructor(code: string, message: string, data?: unknown) {
      super(message)
      this.code = code
      this.data = data
    }
  }

  class RuntimeClient {
    getCliStatus = getCliStatusMock

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode?: string | null,
      environmentSelector?: string | null
    ) {
      runtimeClientConstructorMock(remotePairingCode, environmentSelector)
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    getDefaultUserDataPath: getDefaultUserDataPathMock
  }
})

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  runtimeClientConstructorMock.mockReset()
  process.exitCode = 0
})

function createProfile(): {
  userDataPath: string
  dataFile: string
  databaseFile: string
  exportPath: string
} {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-profile-state-cli-'))
  temporaryDirectories.push(userDataPath)
  const profileId = 'profile-cli-recovery'
  const profileDirectory = join(userDataPath, 'profiles', profileId)
  mkdirSync(profileDirectory, { recursive: true })
  writeFileSync(
    join(userDataPath, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] }),
    'utf8'
  )
  const dataFile = join(profileDirectory, 'orca-data.json')
  const databaseFile = profileStateDatabaseFile(profileDirectory)
  const exportPath = profileStateJsonExportPath(dataFile, 1)
  writeFileSync(dataFile, JSON.stringify({ settings: { theme: 'old' } }), 'utf8')
  writeFileSync(
    exportPath,
    JSON.stringify({ settings: { theme: 'recovered', electronHttp1CompatibilityMode: true } }),
    'utf8'
  )
  writeFileSync(databaseFile, 'damaged sqlite primary', 'utf8')
  writeFileSync(`${databaseFile}-wal`, 'damaged wal sidecar', 'utf8')
  return { userDataPath, dataFile, databaseFile, exportPath }
}

async function createDatabaseBackup(
  profile: ReturnType<typeof createProfile>,
  profileId = 'profile-cli-recovery'
) {
  const id = createProfileStateDatabaseBackupId()
  const path = profileStateDatabaseBackupPath(profile.databaseFile, id)
  const source = openProfileStateDatabase(join(profile.userDataPath, 'backup-source.db'), profileId)
  try {
    importProfileStateJson(
      source.db,
      JSON.stringify({
        settings: {
          theme: 'sqlite-recovered',
          electronHttp1CompatibilityMode: true,
          httpProxyUrl: 'sealed:unchanged'
        },
        extensionState: { retained: true }
      })
    )
    await writeProfileStateDatabaseSnapshotAsync(source.db, path)
  } finally {
    source.db.close()
  }
  return { id, path }
}

describe('profile-state CLI recovery', () => {
  beforeEach(() => {
    getCliStatusMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        app: { running: false, pid: null },
        runtime: { state: 'not_running', reachable: false, runtimeId: null },
        graph: { state: 'not_running' }
      },
      _meta: { runtimeId: 'test' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('restores the selected export through the offline CLI command', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)

    await main(['profile', 'state', 'rollback', '--revision', '1', '--json'], profile.userDataPath)

    expect(existsSync(profile.databaseFile)).toBe(false)
    expect(readFileSync(profile.dataFile, 'utf8')).toBe(
      JSON.stringify({ settings: { theme: 'recovered', electronHttp1CompatibilityMode: true } })
    )
    expect(
      JSON.parse(readFileSync(join(profile.userDataPath, 'http1-compatibility.json'), 'utf8'))
    ).toMatchObject({
      enabled: true,
      profileId: 'profile-cli-recovery'
    })
    const output = vi.mocked(console.log).mock.calls.at(-1)?.[0]
    expect(String(output)).toContain('quarantineDirectory')
    expect(getCliStatusMock).toHaveBeenCalledOnce()
  })

  it('adopts current JSON through CLI with an honest source description', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    const original = readFileSync(profile.dataFile)
    await main(['profile', 'state', 'rollback', '--current-json'], profile.userDataPath)
    expect(readFileSync(profile.dataFile)).toEqual(original)
    expect(existsSync(profile.databaseFile)).toBe(false)
    const output = String(vi.mocked(console.log).mock.calls.at(-1)?.[0])
    expect(output).toContain('source: current JSON')
    expect(output).not.toContain('revision:')
  })

  it.each([
    ['--current-json', '--revision', '1'],
    ['--current-json', '--backup', '1'],
    ['--current-json=false']
  ])('rejects ambiguous current JSON arguments: %s', async (...flags) => {
    getCliStatusMock.mockClear()
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    await main(['profile', 'state', 'rollback', ...flags, '--json'], profile.userDataPath)
    expect(process.exitCode).toBe(1)
    expect(existsSync(profile.databaseFile)).toBe(true)
    expect(getCliStatusMock).not.toHaveBeenCalled()
  })

  it('keeps profile-state recovery local when remote selection is configured', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    vi.stubEnv('ORCA_PAIRING_CODE', 'remote-pairing-code')
    vi.stubEnv('ORCA_ENVIRONMENT', 'stale-environment')

    await main(['profile', 'state', 'rollback', '--revision', '1', '--json'], profile.userDataPath)

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
    expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain('quarantineDirectory')
  })

  it.each([true, false])(
    'recovers an absent database and archives every export (legacy JSON present: %s)',
    async (hasJson) => {
      const profile = createProfile()
      getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
      rmSync(profile.databaseFile)
      rmSync(`${profile.databaseFile}-wal`)
      if (!hasJson) {
        rmSync(profile.dataFile)
      }
      const laterExport = profileStateJsonExportPath(profile.dataFile, 2)
      writeFileSync(laterExport, JSON.stringify({ settings: { theme: 'later' } }))
      const selectedBytes = readFileSync(profile.exportPath)
      const laterBytes = readFileSync(laterExport)

      await main(
        ['profile', 'state', 'rollback', '--revision', '1', '--json'],
        profile.userDataPath
      )

      expect(process.exitCode).toBe(0)
      expect(readFileSync(profile.dataFile)).toEqual(selectedBytes)
      expect(existsSync(profile.exportPath)).toBe(false)
      expect(existsSync(laterExport)).toBe(false)
      const output: unknown = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
      expect(output).toMatchObject({ ok: true, result: { removedDatabaseFiles: [] } })
      if (
        !output ||
        typeof output !== 'object' ||
        !('result' in output) ||
        !output.result ||
        typeof output.result !== 'object' ||
        !('quarantineDirectory' in output.result) ||
        typeof output.result.quarantineDirectory !== 'string'
      ) {
        throw new Error('Expected rollback archive directory')
      }
      const archive = output.result.quarantineDirectory
      expect(readFileSync(join(archive, basename(profile.exportPath)))).toEqual(selectedBytes)
      expect(readFileSync(join(archive, basename(laterExport)))).toEqual(laterBytes)
      expect(existsSync(join(archive, basename(profile.dataFile)))).toBe(hasJson)
      expect(readPersistedHttp1CompatibilityMode(profile.userDataPath)).toBe(true)
    }
  )

  it('preserves all live recovery sources when archiving an export fails', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    const unavailableExport = profileStateJsonExportPath(profile.dataFile, 2)
    mkdirSync(unavailableExport)
    const original = readFileSync(profile.dataFile)

    await main(['profile', 'state', 'rollback', '--revision', '1', '--json'], profile.userDataPath)

    expect(process.exitCode).toBe(1)
    expect(readFileSync(profile.dataFile)).toEqual(original)
    expect(existsSync(profile.exportPath)).toBe(true)
    expect(existsSync(profile.databaseFile)).toBe(true)
    expect(existsSync(`${profile.databaseFile}-wal`)).toBe(true)
  })

  it('falls back to restored settings when refreshing the marker fails', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    http1Marker.writeHttp1CompatibilityMarker(profile.userDataPath, false, 'profile-cli-recovery')
    const writeFileDurableSync = durableFileWrite.writeFileDurableSync
    vi.spyOn(durableFileWrite, 'writeFileDurableSync').mockImplementation(
      (tmp, target, contents) => {
        if (target === join(profile.userDataPath, http1Marker.HTTP1_COMPATIBILITY_MARKER_FILE)) {
          throw new Error('injected marker write failure')
        }
        return writeFileDurableSync(tmp, target, contents)
      }
    )

    await main(['profile', 'state', 'rollback', '--revision', '1', '--json'], profile.userDataPath)

    expect(existsSync(profile.databaseFile)).toBe(false)
    expect(
      http1Marker.readHttp1CompatibilityMarker(profile.userDataPath, 'profile-cli-recovery')
    ).toBeNull()
    expect(readPersistedHttp1CompatibilityMode(profile.userDataPath)).toBe(true)
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain('quarantineDirectory')
  })

  it('preserves SQLite authority when the old marker cannot be invalidated', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    // A directory at the marker path makes non-recursive removal fail on every supported OS.
    mkdirSync(join(profile.userDataPath, http1Marker.HTTP1_COMPATIBILITY_MARKER_FILE))

    await main(['profile', 'state', 'rollback', '--revision', '1', '--json'], profile.userDataPath)

    expect(readFileSync(profile.databaseFile, 'utf8')).toBe('damaged sqlite primary')
    expect(existsSync(profile.exportPath)).toBe(true)
    expect(readFileSync(profile.dataFile, 'utf8')).toBe(
      JSON.stringify({ settings: { theme: 'old' } })
    )
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).not.toContain(
      'quarantineDirectory'
    )
    expect(process.exitCode).toBe(1)
  })

  it('does not invalidate the active setting for an invalid recovery export', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    http1Marker.writeHttp1CompatibilityMarker(profile.userDataPath, true, 'profile-cli-recovery')
    writeFileSync(profile.exportPath, 'invalid JSON')

    await main(['profile', 'state', 'rollback', '--revision', '1', '--json'], profile.userDataPath)

    expect(existsSync(profile.databaseFile)).toBe(true)
    expect(
      http1Marker.readHttp1CompatibilityMarker(profile.userDataPath, 'profile-cli-recovery')
    ).toBe(true)
    expect(process.exitCode).toBe(1)
  })

  it('rejects an explicit remote selector instead of silently ignoring it', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)

    await main(
      ['profile', 'state', 'rollback', '--revision', '1', '--environment', 'remote', '--json'],
      profile.userDataPath
    )

    expect(existsSync(profile.databaseFile)).toBe(true)
    expect(vi.mocked(console.log).mock.calls.at(-1)?.[0]).toContain(
      '`--environment` does not retarget profile-state recovery'
    )
  })

  it.each([['--revision', '1'], ['--current-json']])(
    'refuses rollback while runtime is reachable: %s',
    async (...flags) => {
      const profile = createProfile()
      getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
      getCliStatusMock.mockResolvedValueOnce({
        id: 'status',
        ok: true,
        result: {
          app: { running: true, pid: 123 },
          runtime: { state: 'ready', reachable: true, runtimeId: 'desktop' },
          graph: { state: 'ready' }
        },
        _meta: { runtimeId: 'test' }
      })

      await main(['profile', 'state', 'rollback', ...flags], profile.userDataPath)

      expect(existsSync(profile.databaseFile)).toBe(true)
      expect(readFileSync(profile.dataFile, 'utf8')).toBe(
        JSON.stringify({ settings: { theme: 'old' } })
      )
      expect(vi.mocked(console.error).mock.calls.at(-1)?.[0]).toContain('Stop Orca')
    }
  )

  it('lists SQLite backups alongside JSON exports without opening the damaged primary', async () => {
    const profile = createProfile()
    const backup = await createDatabaseBackup(profile)
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    getCliStatusMock.mockClear()

    await main(['profile', 'state', 'exports', '--json'], profile.userDataPath)

    const output: unknown = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
    expect(output).toMatchObject({
      ok: true,
      result: { exportPaths: [profile.exportPath], backups: [{ id: backup.id, path: backup.path }] }
    })
    expect(getCliStatusMock).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'restores SQLite backup authority with damaged database present=%s',
    async (hasDatabase) => {
      const profile = createProfile()
      const backup = await createDatabaseBackup(profile)
      getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
      http1Marker.writeHttp1CompatibilityMarker(profile.userDataPath, false, 'profile-cli-recovery')
      if (!hasDatabase) {
        rmSync(profile.databaseFile)
        rmSync(`${profile.databaseFile}-wal`)
        rmSync(profile.dataFile)
      }

      await main(
        ['profile', 'state', 'rollback', '--backup', backup.id, '--json'],
        profile.userDataPath
      )

      expect(process.exitCode).toBe(0)
      expect(existsSync(profile.dataFile)).toBe(false)
      expect(existsSync(backup.path)).toBe(true)
      const restored = openProfileStateDatabaseReadOnly(
        profile.databaseFile,
        'profile-cli-recovery'
      )
      try {
        expect(JSON.parse(exportProfileStateJson(restored.db))).toMatchObject({
          settings: { theme: 'sqlite-recovered', httpProxyUrl: 'sealed:unchanged' },
          extensionState: { retained: true }
        })
      } finally {
        restored.db.close()
      }
      expect(
        http1Marker.readHttp1CompatibilityMarker(profile.userDataPath, 'profile-cli-recovery')
      ).toBe(true)
      expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain('"storage": "sqlite"')
    }
  )

  it('rejects a backup belonging to another profile before invalidating the startup marker', async () => {
    const profile = createProfile()
    const backup = await createDatabaseBackup(profile, 'foreign-profile')
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    http1Marker.writeHttp1CompatibilityMarker(profile.userDataPath, true, 'profile-cli-recovery')

    await main(
      ['profile', 'state', 'rollback', '--backup', backup.id, '--json'],
      profile.userDataPath
    )

    expect(process.exitCode).toBe(1)
    expect(readFileSync(profile.databaseFile, 'utf8')).toBe('damaged sqlite primary')
    expect(
      http1Marker.readHttp1CompatibilityMarker(profile.userDataPath, 'profile-cli-recovery')
    ).toBe(true)
  })

  it('requires an unambiguous retained backup selection', async () => {
    const profile = createProfile()
    const backup = await createDatabaseBackup(profile)
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)

    await main(
      ['profile', 'state', 'rollback', '--backup', backup.id, '--revision', '1', '--json'],
      profile.userDataPath
    )

    expect(process.exitCode).toBe(1)
    expect(readFileSync(profile.databaseFile, 'utf8')).toBe('damaged sqlite primary')
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain('exactly one')
  })

  it('rejects escaping backup IDs without touching any recovery artifact', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)

    await main(
      ['profile', 'state', 'rollback', '--backup', '../../outside', '--json'],
      profile.userDataPath
    )

    expect(process.exitCode).toBe(1)
    expect(readFileSync(profile.databaseFile, 'utf8')).toBe('damaged sqlite primary')
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain('backup is unavailable')
  })

  it('refuses database backup restoration while the app is running', async () => {
    const profile = createProfile()
    const backup = await createDatabaseBackup(profile)
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    getCliStatusMock.mockResolvedValueOnce({
      result: { app: { running: true }, runtime: { reachable: false } }
    })

    await main(
      ['profile', 'state', 'rollback', '--backup', backup.id, '--json'],
      profile.userDataPath
    )

    expect(process.exitCode).toBe(1)
    expect(readFileSync(profile.databaseFile, 'utf8')).toBe('damaged sqlite primary')
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain('Stop Orca')
  })
})
