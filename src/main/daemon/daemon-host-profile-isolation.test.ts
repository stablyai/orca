import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { daemonHostStagingName } from './daemon-host-reclaim'
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import {
  getDaemonHostRootDir,
  materializeRelocatedDaemonHost,
  pruneDaemonHostStaging,
  pruneOldDaemonHosts
} from './daemon-host-relocation'

const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA
const DEAD_WRITER_PID = 2_000_011
const LIVE_WRITER_PID = 2_000_012
let tempDir: string
let localAppData: string

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function useProfile(userDataPath: string): void {
  setAppEnvironment({
    getPath: () => userDataPath,
    getAppPath: () => join(tempDir, 'app', 'resources', 'app.asar'),
    getVersion: () => '9.9.9',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
}

function materializedBuild(): string {
  const host = materializeRelocatedDaemonHost()
  if (!host) {
    throw new Error('fixture host was not materialized')
  }
  return dirname(host.execPath)
}

function seedDir(path: string, exe: string): string {
  mkdirSync(join(path, 'resources'), { recursive: true })
  writeFileSync(join(path, 'Orca.exe'), exe)
  return path
}

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-host-profiles-'))
  localAppData = join(tempDir, 'localAppData')
  process.env.LOCALAPPDATA = localAppData
  setProcessProp('platform', 'win32')
  buildInstallFixture(join(tempDir, 'app'))
  setProcessProp('execPath', join(tempDir, 'app', 'Orca.exe'))
  setProcessProp('resourcesPath', join(tempDir, 'app', 'resources'))
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === DEAD_WRITER_PID) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  setProcessProp('platform', originalPlatform)
  setProcessProp('execPath', originalExecPath)
  setProcessProp('resourcesPath', originalResourcesPath)
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData
  }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('daemon-host profile isolation under a shared LOCALAPPDATA', () => {
  it('gives each userData profile its own same-version mirror', () => {
    useProfile(join(tempDir, 'profile-a'))
    const rootA = getDaemonHostRootDir()
    const buildA = materializedBuild()
    useProfile(join(tempDir, 'profile-b'))
    const rootB = getDaemonHostRootDir()
    const buildB = materializedBuild()

    expect(rootA).not.toBe(rootB)
    expect(dirname(rootA)).toBe(join(localAppData, 'Orca', 'daemon-host-profiles'))
    expect(dirname(dirname(buildA))).toBe(rootA)
    expect(dirname(dirname(buildB))).toBe(rootB)
    // The same profile spelled differently must not fork a second mirror.
    useProfile(`${join(tempDir, 'PROFILE-A')}\\`)
    expect(getDaemonHostRootDir()).toBe(rootA)
  })

  it('never touches a live profile when another profile reclaims', () => {
    useProfile(join(tempDir, 'profile-a'))
    const buildA = materializedBuild()
    const versionRootA = dirname(buildA)
    const staleA = seedDir(join(versionRootA, 'build-stale-aaaaaaaaaaaa'), 'a-stale')
    const stagingA = seedDir(
      join(versionRootA, daemonHostStagingName(DEAD_WRITER_PID, 'aaaaaaaaaaaa')),
      'a-staging'
    )
    const oldVersionA = seedDir(join(dirname(versionRootA), '1.0.0'), 'a-old')

    useProfile(join(tempDir, 'profile-b'))
    const buildB = materializedBuild()
    const versionRootB = dirname(buildB)
    const staleB = seedDir(join(versionRootB, 'build-stale-bbbbbbbbbbbb'), 'b-stale')
    const deadStagingB = seedDir(
      join(versionRootB, daemonHostStagingName(DEAD_WRITER_PID, 'bbbbbbbbbbbb')),
      'b-staging'
    )
    const liveStagingB = seedDir(
      join(versionRootB, daemonHostStagingName(LIVE_WRITER_PID, 'cccccccccccc')),
      'b-live-staging'
    )
    const oldVersionB = seedDir(join(dirname(versionRootB), '1.0.0'), 'b-old')

    pruneDaemonHostStaging()
    pruneOldDaemonHosts({ status: 'complete', versionLiveness: new Map() })

    for (const [dir, exe] of [
      [buildA, null],
      [staleA, 'a-stale'],
      [stagingA, 'a-staging'],
      [oldVersionA, 'a-old']
    ] as const) {
      expect(existsSync(join(dir, 'Orca.exe'))).toBe(true)
      if (exe) {
        expect(readFileSync(join(dir, 'Orca.exe'), 'utf8')).toBe(exe)
      }
    }
    expect(existsSync(join(buildB, 'Orca.exe'))).toBe(true)
    expect(existsSync(join(liveStagingB, 'Orca.exe'))).toBe(true)
    expect(existsSync(staleB)).toBe(true)
    expect(existsSync(deadStagingB)).toBe(false)
    expect(existsSync(oldVersionB)).toBe(false)
  })

  it('keeps legacy unscoped mirrors that older daemons may still run from', () => {
    const legacyRoot = join(localAppData, 'Orca', 'daemon-host')
    const legacyCurrent = seedDir(join(legacyRoot, '9.9.9', 'build-legacy-000000000000'), 'cur')
    const legacyStaging = seedDir(
      join(legacyRoot, '9.9.9', daemonHostStagingName(DEAD_WRITER_PID, '000000000000')),
      'staging'
    )
    const legacyOld = seedDir(join(legacyRoot, '1.0.0'), 'old')
    useProfile(join(tempDir, 'profile-a'))
    materializedBuild()

    pruneOldDaemonHosts({ status: 'complete', versionLiveness: new Map() })

    expect(existsSync(join(legacyCurrent, 'Orca.exe'))).toBe(true)
    expect(existsSync(join(legacyStaging, 'Orca.exe'))).toBe(true)
    expect(existsSync(join(legacyOld, 'Orca.exe'))).toBe(true)
  })

  it('stays under userData when LOCALAPPDATA is unset', () => {
    delete process.env.LOCALAPPDATA
    useProfile(join(tempDir, 'profile-a'))
    expect(getDaemonHostRootDir()).toBe(join(tempDir, 'profile-a', 'daemon-host'))
  })
})
