import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import { materializeRelocatedDaemonHost } from './daemon-host-relocation'
import { getDaemonPidPath } from './daemon-spawner'

const harness = vi.hoisted(() => ({
  prepareDaemonReplacement: vi.fn(),
  launchDaemonChild: vi.fn(),
  holdDaemonAdoptionLease: vi.fn(),
  entryPath: ''
}))

vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin(): Promise<void> {
      return Promise.reject(new Error('no daemon answering'))
    }
    disconnect(): void {}
  }
}))
vi.mock('./daemon-endpoint-adoption', () => ({
  DaemonEndpointOwnershipError: class extends Error {},
  holdDaemonAdoptionLease: harness.holdDaemonAdoptionLease,
  reconcileDaemonPidOwnership: vi.fn()
}))
vi.mock('./daemon-launched-child', () => ({
  DaemonEndpointUnavailableError: class extends Error {},
  launchDaemonChild: harness.launchDaemonChild,
  terminateLaunchedDaemonChild: vi.fn()
}))
vi.mock('./daemon-launch-paths', () => ({
  getDaemonEntryPath: () => harness.entryPath,
  probeDaemonSocket: vi.fn(async () => false)
}))
vi.mock('./daemon-replacement-preflight', () => ({
  prepareDaemonReplacement: harness.prepareDaemonReplacement
}))
vi.mock('./daemon-socket-endpoint-path', () => ({ ensureDaemonSocketDir: vi.fn() }))
vi.mock('./daemon-protocol-cleanup', () => ({ cleanupDaemonForProtocol: vi.fn() }))

const { createOutOfProcessLauncher } = await import('./daemon-out-of-process-launcher')

const STALE_DAEMON_PID = 3_000_001
const REPLACEMENT_PID = 3_000_002
const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA
let tempDir: string
let installDir: string
let runtimeDir: string
let staleDaemon: 'live' | 'exited' | 'unqueryable'

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function processError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function writePidRecord(pid: number): void {
  writeFileSync(getDaemonPidPath(runtimeDir), JSON.stringify({ pid, appVersion: '9.9.9' }))
}

function materializedBuild(): string {
  const host = materializeRelocatedDaemonHost()
  if (!host) {
    throw new Error('fixture host was not materialized')
  }
  return dirname(host.execPath)
}

// What the real launch sees at fork time, before the child publishes its live record.
function recordLaunch(oldBuild: string): { oldBuildPresent?: boolean; forkEntryPath?: string } {
  const seen: { oldBuildPresent?: boolean; forkEntryPath?: string } = {}
  harness.launchDaemonChild.mockImplementation(async (options: { forkEntryPath: string }) => {
    seen.oldBuildPresent = existsSync(join(oldBuild, 'Orca.exe'))
    seen.forkEntryPath = options.forkEntryPath
    writePidRecord(REPLACEMENT_PID)
    return { child: new EventEmitter(), identity: { pid: REPLACEMENT_PID } }
  })
  return seen
}

async function launch(): Promise<void> {
  await createOutOfProcessLauncher(runtimeDir)(
    join(tempDir, 'daemon.sock'),
    join(tempDir, 'daemon.token')
  )
}

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-launcher-host-prune-'))
  installDir = join(tempDir, 'app')
  runtimeDir = join(tempDir, 'userData', 'daemon')
  mkdirSync(runtimeDir, { recursive: true })
  process.env.LOCALAPPDATA = join(tempDir, 'localAppData')
  setProcessProp('platform', 'win32')
  buildInstallFixture(installDir)
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
  harness.entryPath = join(
    installDir,
    'resources',
    'app.asar.unpacked',
    'out',
    'main',
    'daemon-entry.js'
  )
  staleDaemon = 'live'
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === STALE_DAEMON_PID && staleDaemon === 'exited') {
      throw processError('ESRCH')
    }
    if (pid === STALE_DAEMON_PID && staleDaemon === 'unqueryable') {
      throw processError('ETIMEDOUT')
    }
    return true
  })
  harness.holdDaemonAdoptionLease.mockResolvedValue({ shutdown: async () => {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  harness.prepareDaemonReplacement.mockReset()
  harness.launchDaemonChild.mockReset()
  harness.holdDaemonAdoptionLease.mockReset()
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

describe('out-of-process launcher: same-version daemon-host reclaim', () => {
  // Old mirror on disk, a changed source fingerprint with no mirror yet, and a stale
  // same-version daemon whose live record pins every build until preflight retires it.
  function seedSupersededLaunch(): string {
    const oldBuild = materializedBuild()
    writePidRecord(STALE_DAEMON_PID)
    writeFileSync(harness.entryPath, 'entry-rebuilt-same-version')
    return oldBuild
  }

  it('reclaims the superseded build after preflight retires the stale daemon and before fork', async () => {
    const oldBuild = seedSupersededLaunch()
    harness.prepareDaemonReplacement.mockImplementation(async () => {
      staleDaemon = 'exited'
      return null
    })
    const seen = recordLaunch(oldBuild)

    await launch()

    expect(seen.oldBuildPresent).toBe(false)
    expect(seen.forkEntryPath).toBeDefined()
    expect(seen.forkEntryPath?.startsWith(oldBuild)).toBe(false)
    expect(existsSync(seen.forkEntryPath ?? '')).toBe(true)
    expect(existsSync(join(oldBuild, 'Orca.exe'))).toBe(false)
  })

  it.each([
    ['still live', 'live'],
    ['unverifiable', 'unqueryable']
  ] as const)(
    'keeps the superseded build when the stale daemon is %s after preflight',
    async (_label, verdict) => {
      const oldBuild = seedSupersededLaunch()
      harness.prepareDaemonReplacement.mockImplementation(async () => {
        staleDaemon = verdict
        return null
      })
      const seen = recordLaunch(oldBuild)

      await launch()

      expect(seen.oldBuildPresent).toBe(true)
      expect(seen.forkEntryPath?.startsWith(oldBuild)).toBe(false)
      expect(existsSync(seen.forkEntryPath ?? '')).toBe(true)
    }
  )

  it('reclaims nothing when preflight adopts the running daemon', async () => {
    const oldBuild = seedSupersededLaunch()
    harness.prepareDaemonReplacement.mockResolvedValue({ adopted: true, shutdown: async () => {} })

    await launch()

    expect(harness.launchDaemonChild).not.toHaveBeenCalled()
    expect(existsSync(join(oldBuild, 'Orca.exe'))).toBe(true)
  })
})
