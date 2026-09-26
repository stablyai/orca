import type * as NodeFs from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROFILE_STATE_RECOVERY_FLAG,
  PROFILE_STATE_RECOVERY_RESULT_PREFIX
} from '../../shared/profile-state-recovery-command'
import { acquireProfileStateRuntimeAdmission } from '../persistence/profile-state/profile-state-access'
import { profileStateJsonExportPath } from '../persistence/profile-state/profile-state-export-path'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from '../persistence/profile-state/profile-state-backup-path'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import {
  importProfileStateJson,
  readProfileStateSnapshot
} from '../persistence/profile-state/profile-state-documents'
import { writeProfileStateDatabaseSnapshotAsync } from '../persistence/profile-state/profile-state-database-snapshot'
import * as marker from './http1-compatibility-marker'
import { runProfileStateRecoveryPreflight } from './profile-state-recovery-preflight'

const mocks = vi.hoisted(() => ({
  setPath: vi.fn(),
  requestSingleInstanceLock: vi.fn(),
  on: vi.fn(),
  exit: vi.fn(),
  background: vi.fn(),
  output: vi.fn()
}))
vi.mock('electron', () => ({ app: mocks }))
vi.mock('../window/foreground-activation-policy', () => ({
  applyBackgroundActivationPolicy: mocks.background
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>()
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === 1) {
        mocks.output(args[1])
        return
      }
      return fs.writeFileSync(...args)
    }
  }
})

const roots: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.requestSingleInstanceLock.mockReturnValue(true)
  vi.stubEnv('ORCA_USER_DATA_PATH', '/stale/inherited/root')
  vi.stubEnv('ORCA_BYPASS_SINGLE_INSTANCE_LOCK', '1')
  vi.stubEnv('ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK', '0')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-recovery-bridge-')))
  roots.push(root)
  const profileId = 'bridge-profile'
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = join(directory, 'profile-state.db')
  const exportFile = profileStateJsonExportPath(dataFile, 1)
  const restored = {
    settings: { electronHttp1CompatibilityMode: true },
    unknown: { sealed: 'unchanged', missing: null }
  }
  writeFileSync(dataFile, JSON.stringify({ old: true }))
  writeFileSync(databaseFile, 'broken database')
  writeFileSync(exportFile, JSON.stringify(restored))
  const argv = [
    'Orca',
    '--serve',
    PROFILE_STATE_RECOVERY_FLAG,
    JSON.stringify({ userDataPath: root, selector: { kind: 'json', revision: 1 } })
  ]
  return { root, profileId, dataFile, databaseFile, exportFile, restored, argv }
}

function response(): unknown {
  const output: unknown = mocks.output.mock.calls[0]?.[0]
  expect(typeof output).toBe('string')
  if (typeof output !== 'string') {
    throw new Error('Missing response')
  }
  return JSON.parse(output.slice(PROFILE_STATE_RECOVERY_RESULT_PREFIX.length))
}

describe('Electron recovery preflight', () => {
  it('runs the recovery branch before CLI redirect or ordinary startup admission', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
      'utf8'
    )
    const start = source.indexOf('export function runMainProcessPreflight(')
    const recovery = source.indexOf('if (runProfileStateRecoveryPreflight())', start)
    const redirect = source.indexOf('const cliLaunchRedirect = maybeRedirectCliLaunch(', start)
    const admission = source.indexOf('acquireProfileStateRuntimeAdmission(', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(recovery).toBeGreaterThan(start)
    expect(redirect).toBeGreaterThan(recovery)
    expect(admission).toBeGreaterThan(redirect)
    expect(source.slice(recovery, redirect)).toContain('return false')
  })

  it('leaves ordinary startup untouched', () => {
    expect(runProfileStateRecoveryPreflight(['Orca', '--serve'])).toBe(false)
    expect(mocks.background).not.toHaveBeenCalled()
    expect(mocks.setPath).not.toHaveBeenCalled()
    expect(mocks.exit).not.toHaveBeenCalled()
  })

  it.each(['json', 'current-json'] as const)(
    'restores %s under both locks despite ordinary singleton bypasses',
    (kind) => {
      const item = fixture()
      if (kind === 'current-json') {
        writeFileSync(item.dataFile, JSON.stringify(item.restored))
        item.argv[3] = JSON.stringify({ userDataPath: item.root, selector: { kind } })
      }
      mocks.requestSingleInstanceLock.mockImplementation(() => {
        expect(mocks.setPath).toHaveBeenCalledWith('userData', item.root)
        expect(() => acquireProfileStateRuntimeAdmission(item.root)).toThrow()
        expect(readFileSync(item.databaseFile, 'utf8')).toBe('broken database')
        return true
      })
      expect(runProfileStateRecoveryPreflight(item.argv)).toBe(true)
      expect(process.env.ORCA_USER_DATA_PATH).toBe(item.root)
      expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
      expect(mocks.background).toHaveBeenCalledOnce()
      expect(mocks.requestSingleInstanceLock).toHaveBeenCalledOnce()
      expect(response()).toMatchObject({
        ok: true,
        result: {
          storage: 'json',
          revision: kind === 'json' ? 1 : null,
          restoredPath: item.dataFile
        }
      })
      expect(JSON.parse(readFileSync(item.dataFile, 'utf8'))).toEqual(item.restored)
      expect(existsSync(item.databaseFile)).toBe(false)
      expect(existsSync(item.exportFile)).toBe(false)
      expect(mocks.exit).toHaveBeenCalledWith(0)
      const runtime = acquireProfileStateRuntimeAdmission(item.root)
      runtime.release()
    }
  )

  it('refuses an old native singleton owner without modifying authority or exports', () => {
    const item = fixture()
    mocks.requestSingleInstanceLock.mockReturnValue(false)
    expect(runProfileStateRecoveryPreflight(item.argv)).toBe(true)
    expect(response()).toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: expect.stringContaining('Stop Orca')
    })
    expect(readFileSync(item.databaseFile, 'utf8')).toBe('broken database')
    expect(JSON.parse(readFileSync(item.dataFile, 'utf8'))).toEqual({ old: true })
    expect(existsSync(item.exportFile)).toBe(true)
    expect(mocks.exit).toHaveBeenCalledWith(1)
    const runtime = acquireProfileStateRuntimeAdmission(item.root)
    runtime.release()
  })

  it('exits quietly when the CLI closes its response pipe after a successful restore', () => {
    const item = fixture()
    mocks.output.mockImplementationOnce(() => {
      throw new Error('EPIPE')
    })
    expect(() => runProfileStateRecoveryPreflight(item.argv)).not.toThrow()
    expect(JSON.parse(readFileSync(item.dataFile, 'utf8'))).toEqual(item.restored)
    expect(mocks.exit).toHaveBeenCalledWith(1)
    const runtime = acquireProfileStateRuntimeAdmission(item.root)
    runtime.release()
  })

  it('restores a real SQLite backup and retains root exclusion through marker publication', async () => {
    const item = fixture()
    rmSync(item.databaseFile)
    const source = openProfileStateDatabase(item.databaseFile, item.profileId)
    const backupId = createProfileStateDatabaseBackupId()
    const backupFile = profileStateDatabaseBackupPath(item.databaseFile, backupId)
    try {
      importProfileStateJson(source.db, JSON.stringify(item.restored))
      await writeProfileStateDatabaseSnapshotAsync(source.db, backupFile)
      importProfileStateJson(source.db, JSON.stringify({ newer: true }), { expectedRevision: 1 })
    } finally {
      source.db.close()
    }
    const markerWrite = marker.writeHttp1CompatibilityMarker
    const write = vi
      .spyOn(marker, 'writeHttp1CompatibilityMarker')
      .mockImplementation((...args) => {
        expect(() => acquireProfileStateRuntimeAdmission(item.root)).toThrow()
        expect(mocks.requestSingleInstanceLock).toHaveBeenCalledOnce()
        markerWrite(...args)
      })
    const argv = [
      'Orca',
      '--serve',
      PROFILE_STATE_RECOVERY_FLAG,
      JSON.stringify({ userDataPath: item.root, selector: { kind: 'sqlite', backupId } })
    ]
    expect(runProfileStateRecoveryPreflight(argv)).toBe(true)
    expect(response()).toMatchObject({
      ok: true,
      result: { storage: 'sqlite', backupId, revision: 1 }
    })
    expect(write).toHaveBeenCalledWith(item.root, true, item.profileId)
    expect(existsSync(item.dataFile)).toBe(false)
    expect(existsSync(backupFile)).toBe(true)
    const restored = openProfileStateDatabaseReadOnly(item.databaseFile, item.profileId)
    try {
      expect(JSON.parse(readProfileStateSnapshot(restored.db).json)).toEqual(item.restored)
    } finally {
      restored.db.close()
    }
    expect(mocks.exit).toHaveBeenCalledWith(0)
  })

  it('refuses a participating Node runtime before asking for the Electron lock', () => {
    const item = fixture()
    const runtime = acquireProfileStateRuntimeAdmission(item.root)
    try {
      expect(runProfileStateRecoveryPreflight(item.argv)).toBe(true)
      expect(response()).toMatchObject({ ok: false, code: 'runtime_error' })
      expect(mocks.requestSingleInstanceLock).not.toHaveBeenCalled()
      expect(existsSync(item.exportFile)).toBe(true)
    } finally {
      runtime.release()
    }
  })

  it.each([
    ['Orca', PROFILE_STATE_RECOVERY_FLAG, '{}'],
    ['Orca', '--serve', PROFILE_STATE_RECOVERY_FLAG],
    ['Orca', '--serve', PROFILE_STATE_RECOVERY_FLAG, '{}'],
    [
      'Orca',
      '--serve',
      PROFILE_STATE_RECOVERY_FLAG,
      JSON.stringify({ userDataPath: 'relative', selector: { kind: 'json', revision: 1 } })
    ],
    ['Orca', '--serve', PROFILE_STATE_RECOVERY_FLAG, '{}', PROFILE_STATE_RECOVERY_FLAG, '{}']
  ])('fails closed for malformed launch %j', (...argv) => {
    expect(runProfileStateRecoveryPreflight(argv)).toBe(true)
    expect(response()).toMatchObject({ ok: false })
    expect(mocks.setPath).not.toHaveBeenCalled()
    expect(mocks.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(mocks.exit).toHaveBeenCalledWith(1)
  })
})
