import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHostModule from '@orca/process-host'
import * as http1Marker from '../../main/startup/http1-compatibility-marker'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../../main/persistence/profile-state/database/profile-state-database'
import { profileStateDatabaseFile } from '../../shared/profile-state-storage-paths'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../../main/persistence/profile-state/documents/profile-state-documents'
import { profileStateJsonExportPath } from '../../main/persistence/profile-state/legacy-json/profile-state-export-path'
import { main } from '../index'

const {
  getCliStatusMock,
  getDefaultUserDataPathMock,
  runProcessMock,
  runtimeClientConstructorMock
} = vi.hoisted(() => ({
  getCliStatusMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(),
  runProcessMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn()
}))

// Only the bundled-recovery case stubs the child; other cases keep the real process host.
vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHostModule>()
  runProcessMock.mockImplementation(actual.runProcess)
  return { ...actual, runProcess: runProcessMock }
})

vi.mock('../runtime/client', () => {
  class RuntimeClient {
    async getOfflineRuntimeAdmission() {
      const status = await getCliStatusMock()
      return {
        reachable: status.result.runtime.reachable,
        legacyPidRunning: status.result.app.running,
        pid: status.result.app.pid ?? null
      }
    }

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode?: string | null,
      environmentSelector?: string | null
    ) {
      runtimeClientConstructorMock(remotePairingCode, environmentSelector)
    }
  }
  return { RuntimeClient }
})

vi.mock('../runtime/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

const temporaryDirectories: string[] = []
let previousExitCode: typeof process.exitCode

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = previousExitCode
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

describe('profile-state CLI recovery', () => {
  beforeEach(() => {
    previousExitCode = process.exitCode
    process.exitCode = 0
    runtimeClientConstructorMock.mockReset()
    getDefaultUserDataPathMock.mockReset()
    vi.stubEnv('ORCA_PAIRING_CODE', undefined)
    vi.stubEnv('ORCA_ENVIRONMENT', undefined)
    getCliStatusMock.mockReset().mockResolvedValue({
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

  it('keeps current history through CLI repair and reports its source honestly', async () => {
    const profile = createProfile()
    getDefaultUserDataPathMock.mockReturnValue(profile.userDataPath)
    rmSync(profile.databaseFile)
    rmSync(`${profile.databaseFile}-wal`)
    rmSync(profile.dataFile)
    const runs = [{ id: 'recent-run', status: 'completed' }]
    const opened = openProfileStateDatabase(profile.databaseFile, 'profile-cli-recovery')
    try {
      importProfileStateJson(opened.db, JSON.stringify({ automationRuns: runs }))
      opened.db.exec(
        "UPDATE profile_state_documents SET content_hash = 'broken' WHERE domain = 'automationRuns'"
      )
    } finally {
      opened.db.close()
    }
    await main(['profile', 'state', 'rollback', '--repair'], profile.userDataPath)
    expect(process.exitCode).toBe(0)
    const output = String(vi.mocked(console.log).mock.calls.at(-1)?.[0])
    expect(output).toContain('repaired automationRuns: current runs kept')
    expect(output).not.toContain('starts empty')
    const repaired = openProfileStateDatabaseReadOnly(profile.databaseFile, 'profile-cli-recovery')
    try {
      expect(JSON.parse(exportProfileStateJson(repaired.db))).toEqual({ automationRuns: runs })
    } finally {
      repaired.db.close()
    }
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
})
