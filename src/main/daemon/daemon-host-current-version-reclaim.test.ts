import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { daemonHostStagingName } from './daemon-host-reclaim'
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import {
  collectPinnedDaemonVersions,
  getDaemonHostRootDir,
  materializeRelocatedDaemonHost,
  pruneDaemonHostStaging,
  pruneOldDaemonHosts
} from './daemon-host-relocation'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'

const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA
let tempDir: string
let installDir: string
let versionRoot: string
const DEAD_WRITER_PID = 2_000_001
const LIVE_WRITER_PID = 2_000_002
const UNQUERYABLE_WRITER_PID = 2_000_003

function processError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

// Writer liveness by pid; any other pid (e.g. a daemon record) answers as alive.
function stubWriterLiveness(): void {
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === DEAD_WRITER_PID) {
      throw processError('ESRCH')
    }
    if (pid === UNQUERYABLE_WRITER_PID) {
      throw processError('ETIMEDOUT')
    }
    return true
  })
}

function seedStaging(name: string): string {
  const staging = join(versionRoot, name)
  mkdirSync(join(staging, 'resources'), { recursive: true })
  writeFileSync(join(staging, 'Orca.exe'), 'partial-exe')
  return staging
}

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function useInstall(dir: string): void {
  installDir = dir
  setAppEnvironment({
    getPath: () => join(tempDir, 'userData'),
    getAppPath: () => join(installDir, 'resources', 'app.asar'),
    getVersion: () => '9.9.9',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  setProcessProp('execPath', join(installDir, 'Orca.exe'))
  setProcessProp('resourcesPath', join(installDir, 'resources'))
}

function selectedBuild(): string {
  const host = materializeRelocatedDaemonHost()
  if (!host) {
    throw new Error('fixture host was not materialized')
  }
  return dirname(host.execPath)
}

// Leftovers a crash mid-copy, a repaired mirror, and the pre-build-dir layout leave behind.
function seedLeftovers(): { staleBuild: string; staging: string; legacyExe: string } {
  const staleBuild = join(versionRoot, 'build-stale-000000000000')
  mkdirSync(join(staleBuild, 'resources'), { recursive: true })
  writeFileSync(join(staleBuild, 'Orca.exe'), 'stale-exe')
  const staging = seedStaging(daemonHostStagingName(DEAD_WRITER_PID, '0123456789ab'))
  const legacyExe = join(versionRoot, 'Orca.exe')
  writeFileSync(legacyExe, 'legacy-exe')
  return { staleBuild, staging, legacyExe }
}

function prune(versionLiveness: [string, ProcessLivenessVerdict][]): void {
  pruneOldDaemonHosts({ status: 'complete', versionLiveness: new Map(versionLiveness) })
}

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-host-current-reclaim-'))
  process.env.LOCALAPPDATA = join(tempDir, 'localAppData')
  setProcessProp('platform', 'win32')
  buildInstallFixture(join(tempDir, 'app'))
  useInstall(join(tempDir, 'app'))
  versionRoot = join(getDaemonHostRootDir(), '9.9.9')
  stubWriterLiveness()
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

describe('current-version daemon-host staging cleanup', () => {
  it('reclaims abandoned staging while retaining all published current-version builds', () => {
    const selected = selectedBuild()
    const { staleBuild, staging, legacyExe } = seedLeftovers()

    prune([])

    expect(existsSync(staging)).toBe(false)
    expect(existsSync(staleBuild)).toBe(true)
    expect(existsSync(join(selected, 'Orca.exe'))).toBe(true)
    expect(existsSync(legacyExe)).toBe(true)
    expect(materializeRelocatedDaemonHost()?.execPath).toBe(join(selected, 'Orca.exe'))
  })

  it.each<[string, ProcessLivenessVerdict]>([
    ['exited', { status: 'exited' }],
    ['live', { status: 'live' }],
    ['unverifiable', { status: 'unverifiable', reason: 'query failed' }]
  ])('preserves every build while a current-version daemon is %s', (_label, verdict) => {
    const selected = selectedBuild()
    const { staleBuild, staging } = seedLeftovers()

    prune([['9.9.9', verdict]])

    expect(existsSync(join(staleBuild, 'Orca.exe'))).toBe(true)
    expect(existsSync(join(selected, 'Orca.exe'))).toBe(true)
    expect(existsSync(staging)).toBe(false)
  })

  it('retains published builds after their previous pid record exits', () => {
    selectedBuild()
    const { staleBuild } = seedLeftovers()
    const runtimeDir = join(tempDir, 'userData', 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      join(runtimeDir, 'daemon-v9.pid'),
      JSON.stringify({ pid: 4242, startedAtMs: null, appVersion: '9.9.9' })
    )
    pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
    expect(existsSync(staleBuild)).toBe(true)

    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw processError('ESRCH')
    })
    pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
    expect(existsSync(staleBuild)).toBe(true)
  })

  it('uses staging writer evidence independently of unverifiable daemon pid evidence', () => {
    selectedBuild()
    const { staleBuild, staging } = seedLeftovers()

    pruneOldDaemonHosts({ status: 'unverifiable', reason: 'runtime dir unreadable' })

    expect(existsSync(staleBuild)).toBe(true)
    expect(existsSync(staging)).toBe(false)
  })

  it('preserves every build when this process cannot identify its own build', () => {
    selectedBuild()
    const { staleBuild, staging } = seedLeftovers()
    const unobserved = join(tempDir, 'unobserved-app')
    buildInstallFixture(unobserved)
    rmSync(
      join(
        unobserved,
        'resources',
        'node_modules',
        '@orca',
        'process-host',
        'dist',
        'run-process.js'
      )
    )
    useInstall(unobserved)

    prune([])

    expect(existsSync(staleBuild)).toBe(true)
    expect(existsSync(staging)).toBe(false)
  })

  it.each([
    ['an active writer', daemonHostStagingName(LIVE_WRITER_PID, 'aaaaaaaaaaaa')],
    ['an unqueryable writer', daemonHostStagingName(UNQUERYABLE_WRITER_PID, 'bbbbbbbbbbbb')],
    ['an unidentified pre-pid writer', '.staging-cccccccccccc']
  ])('preserves staging from %s with no daemon record', (_label, name) => {
    selectedBuild()
    const kept = seedStaging(name)
    const abandoned = seedStaging(daemonHostStagingName(DEAD_WRITER_PID, 'dddddddddddd'))

    prune([])

    expect(existsSync(join(kept, 'Orca.exe'))).toBe(true)
    expect(existsSync(abandoned)).toBe(false)
  })

  it('retains every published build before a replacement writes its pid record', () => {
    const selected = selectedBuild()
    const { staleBuild } = seedLeftovers()
    const runtimeDir = join(tempDir, 'userData', 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    const record = join(runtimeDir, 'daemon-v9.pid')
    expect(existsSync(record)).toBe(false)
    const secondStale = join(versionRoot, 'build-stale-111111111111')

    pruneDaemonHostStaging()
    expect(existsSync(staleBuild)).toBe(true)
    expect(existsSync(join(selected, 'Orca.exe'))).toBe(true)

    // Publication also preserves all current-version mirrors.
    mkdirSync(secondStale, { recursive: true })
    writeFileSync(record, JSON.stringify({ pid: LIVE_WRITER_PID, appVersion: '9.9.9' }))
    pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
    expect(existsSync(secondStale)).toBe(true)
  })

  it('keeps staging off packaged win32', () => {
    selectedBuild()
    const { staleBuild, staging } = seedLeftovers()
    setProcessProp('platform', 'linux')

    pruneDaemonHostStaging()

    expect(existsSync(staleBuild)).toBe(true)
    expect(existsSync(staging)).toBe(true)
  })
})
