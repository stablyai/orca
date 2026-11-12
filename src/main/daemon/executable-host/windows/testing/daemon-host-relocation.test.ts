import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setAppEnvironment, type AppEnvironment } from '../../../../../shared/app-environment'

const hostApp = {
  isPackaged: true,
  userDataPath: '',
  appPath: '',
  version: '9.9.9'
}

function installHostApp(): void {
  setAppEnvironment({
    getPath: () => hostApp.userDataPath,
    getAppPath: () => hostApp.appPath,
    getVersion: () => hostApp.version,
    isPackaged: () => hostApp.isPackaged,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  } as AppEnvironment)
}
import { buildInstallFixture } from './daemon-host-relocation.test-fixture'
import {
  collectPinnedDaemonVersions,
  getDaemonHostRootDir,
  getRelocatedDaemonHost,
  materializeRelocatedDaemonHost,
  pruneOldDaemonHosts
} from '../daemon-host-relocation'

let tempDir: string
let installDir: string
let userDataDir: string
let localAppDataDir: string
const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalResourcesPath = process.resourcesPath
const originalLocalAppData = process.env.LOCALAPPDATA

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function relocatedHostRoot(): string {
  const host = getRelocatedDaemonHost()
  if (!host) {
    throw new Error('fixture host was not materialized')
  }
  return dirname(host.execPath)
}

const PROCESS_TREE_DIR_REL = join('resources', 'node_modules', '@vscode', 'windows-process-tree')

const PROCESS_TREE_ADDON_REL = join(
  'resources',
  'node_modules',
  '@vscode',
  'windows-process-tree',
  'build',
  'Release',
  'windows_process_tree.node'
)

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-host-relocation-'))
  installDir = join(tempDir, 'app')
  userDataDir = join(tempDir, 'userData')
  mkdirSync(userDataDir, { recursive: true })
  localAppDataDir = join(tempDir, 'localAppData')
  mkdirSync(localAppDataDir, { recursive: true })
  process.env.LOCALAPPDATA = localAppDataDir
  buildInstallFixture(installDir)
  hostApp.isPackaged = true
  hostApp.userDataPath = userDataDir
  hostApp.appPath = join(installDir, 'resources', 'app.asar')
  hostApp.version = '9.9.9'
  installHostApp()
  setProcessProp('platform', 'win32')
  setProcessProp('execPath', join(installDir, 'Orca.exe'))
  setProcessProp('resourcesPath', join(installDir, 'resources'))
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
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // Best-effort
  }
})

describe('materializeRelocatedDaemonHost', () => {
  it.each([
    ['the binary', PROCESS_TREE_ADDON_REL],
    ['package.json', join(PROCESS_TREE_DIR_REL, 'package.json')],
    ['lib/index.js', join(PROCESS_TREE_DIR_REL, 'lib', 'index.js')]
  ])('refuses a mirror that lost %s', (_label, relativePath) => {
    materializeRelocatedDaemonHost()
    const dest = relocatedHostRoot()
    expect(getRelocatedDaemonHost()).not.toBeNull()

    rmSync(join(dest, relativePath))

    expect(getRelocatedDaemonHost()).toBeNull()
  })

  it('rematerializes a host whose copied addon went missing', () => {
    materializeRelocatedDaemonHost()
    const dest = relocatedHostRoot()
    const relocatedAddon = join(dest, PROCESS_TREE_ADDON_REL)

    rmSync(relocatedAddon)
    const sentinel = join(dest, 'sentinel.txt')
    writeFileSync(sentinel, 'keep')

    const rebuilt = materializeRelocatedDaemonHost()
    expect(rebuilt).not.toBeNull()
    expect(dirname(rebuilt!.execPath)).not.toBe(dest)
    expect(readFileSync(join(dirname(rebuilt!.execPath), PROCESS_TREE_ADDON_REL), 'utf8')).toBe(
      'process-tree-native'
    )
    expect(existsSync(sentinel)).toBe(true)
  })

  it.each([
    ['the binary', PROCESS_TREE_ADDON_REL],
    ['package.json', join(PROCESS_TREE_DIR_REL, 'package.json')],
    ['lib/index.js', join(PROCESS_TREE_DIR_REL, 'lib', 'index.js')]
  ])('refuses to copy anything when the install lost %s', (_label, relativePath) => {
    // Validate missing sources before an expensive copy that the mirror check would reject.
    rmSync(join(installDir, relativePath))

    expect(materializeRelocatedDaemonHost()).toBeNull()
    expect(existsSync(getDaemonHostRootDir())).toBe(false)
  })

  it('fails open on a missing required input, leaving no dest or staging dir', () => {
    rmSync(join(installDir, 'resources', 'node_modules', 'node-pty'), {
      recursive: true,
      force: true
    })
    const result = materializeRelocatedDaemonHost()
    expect(result).toBeNull()
    const hostRoot = getDaemonHostRootDir()
    const remaining = existsSync(hostRoot) ? readdirSync(hostRoot) : []
    expect(remaining).toEqual([])
  })
})

// Age beyond the publication window so quarantine sees a settled corrupt record.
function ageRecordPastQuarantineFloor(recordPath: string): void {
  const aged = new Date(Date.now() - 5 * 60_000)
  utimesSync(recordPath, aged, aged)
}

describe('pruneOldDaemonHosts', () => {
  it('removes unpinned non-current version dirs, keeping current and pinned', () => {
    const root = getDaemonHostRootDir()
    for (const v of ['9.9.9', '1.0.0', '2.0.0']) {
      mkdirSync(join(root, v), { recursive: true })
    }
    pruneOldDaemonHosts({
      status: 'complete',
      versionLiveness: new Map([['2.0.0', { status: 'live' }]])
    })
    expect(existsSync(join(root, '9.9.9'))).toBe(true)
    expect(existsSync(join(root, '2.0.0'))).toBe(true)
    expect(existsSync(join(root, '1.0.0'))).toBe(false)
  })

  it('keeps a host when its pid liveness query is permission denied', () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '8.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      join(runtimeDir, 'daemon-v8.pid'),
      JSON.stringify({ pid: 4242, startedAtMs: null, appVersion: '8.0.0' })
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('access denied'), { code: 'EPERM' })
    })

    const evidence = collectPinnedDaemonVersions(runtimeDir)
    expect(evidence).toEqual({
      status: 'complete',
      versionLiveness: new Map([['8.0.0', { status: 'live' }]])
    })
    pruneOldDaemonHosts(evidence)

    expect(existsSync(join(root, '8.0.0'))).toBe(true)
    killSpy.mockRestore()
  })

  it('keeps a host when its pid liveness query is unavailable', () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '7.0.0'), { recursive: true })
    mkdirSync(join(root, '6.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      join(runtimeDir, 'daemon-v7.pid'),
      JSON.stringify({ pid: 4242, startedAtMs: null, appVersion: '7.0.0' })
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    })

    const evidence = collectPinnedDaemonVersions(runtimeDir)
    expect(evidence).toEqual({
      status: 'complete',
      versionLiveness: new Map([
        ['7.0.0', { status: 'unverifiable', reason: 'the daemon process could not be queried' }]
      ])
    })
    pruneOldDaemonHosts(evidence)

    expect(existsSync(join(root, '7.0.0'))).toBe(true)
    expect(existsSync(join(root, '6.0.0'))).toBe(false)
    killSpy.mockRestore()
  })

  it('skips pruning when the runtime directory cannot be read', () => {
    const root = getDaemonHostRootDir()
    mkdirSync(join(root, '1.0.0'), { recursive: true })

    const evidence = collectPinnedDaemonVersions(join(userDataDir, 'daemon-never-created'))

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon runtime directory could not be read'
    })
    pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
  })

  it('keeps a version live when any of its pid records is live', () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '7.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // A live daemon must pin its version regardless of directory scan order.
    writeFileSync(
      join(runtimeDir, 'daemon-v7.pid'),
      JSON.stringify({ pid: 5001, startedAtMs: null, appVersion: '7.0.0' })
    )
    writeFileSync(
      join(runtimeDir, 'daemon-v8.pid'),
      JSON.stringify({ pid: 5002, startedAtMs: null, appVersion: '7.0.0' })
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 5001) {
        return true
      }
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    const evidence = collectPinnedDaemonVersions(runtimeDir)
    expect(evidence).toEqual({
      status: 'complete',
      versionLiveness: new Map([['7.0.0', { status: 'live' }]])
    })
    pruneOldDaemonHosts(evidence)

    expect(existsSync(join(root, '7.0.0'))).toBe(true)
    killSpy.mockRestore()
  })

  it('quarantines a record torn inside the pid digits without probing the truncated prefix', () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // A torn PID prefix can name an unrelated process; quarantine must not use it as liveness evidence.
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, '{"pid":123')
    ageRecordPastQuarantineFloor(pidPath)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be parsed and was quarantined: daemon-v7.pid'
    })
    expect(killSpy).not.toHaveBeenCalled()
    expect(existsSync(pidPath)).toBe(false)
    expect(readFileSync(join(runtimeDir, 'daemon-v7.pid.corrupt'), 'utf8')).toBe('{"pid":123')
    warnSpy.mockRestore()
    killSpy.mockRestore()
  })

  it('never quarantines a corrupt record that was just written', () => {
    // wx creates the record before writing it; a fresh empty file may still belong to a live publisher.
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, '')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason:
        'the daemon pid file could not be parsed and was written too recently to quarantine: daemon-v7.pid'
    })
    expect(existsSync(pidPath)).toBe(true)
    expect(existsSync(join(runtimeDir, 'daemon-v7.pid.corrupt'))).toBe(false)
    pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('vetoes pruning while a pid salvaged from a corrupt record still answers', () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // The complete PID still answers; a torn version field cannot justify quarantining its record.
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, '{"pid": 4242, "startedAtMs": 17')
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason:
        'the daemon pid file could not be parsed and salvaged pid 4242 may still be running: daemon-v7.pid'
    })
    expect(existsSync(pidPath)).toBe(true)
    pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    warnSpy.mockRestore()
    killSpy.mockRestore()
  })

  it('quarantines a corrupt record naming no live pid so pruning resumes next launch', () => {
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, 'not a daemon record')
    ageRecordPastQuarantineFloor(pidPath)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)
    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be parsed and was quarantined: daemon-v7.pid'
    })
    pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    expect(existsSync(pidPath)).toBe(false)
    expect(readFileSync(join(runtimeDir, 'daemon-v7.pid.corrupt'), 'utf8')).toBe(
      'not a daemon record'
    )

    const nextEvidence = collectPinnedDaemonVersions(runtimeDir)
    expect(nextEvidence).toEqual({ status: 'complete', versionLiveness: new Map() })
    pruneOldDaemonHosts(nextEvidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(false)
    warnSpy.mockRestore()
  })

  it('vetoes pruning without quarantine when a pid record cannot be read', (ctx) => {
    // process.platform is mocked; permission fixtures depend on the actual host.
    if (originalPlatform === 'win32') {
      return ctx.skip()
    }
    const root = getDaemonHostRootDir()
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, JSON.stringify({ pid: 4242, startedAtMs: null, appVersion: '1.0.0' }))
    chmodSync(pidPath, 0o000)
    try {
      readFileSync(pidPath)
      return ctx.skip() // Running as root: the permission bit cannot make the read fail.
    } catch {}

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    // Transient read failures veto pruning without quarantining the record.
    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be read: daemon-v7.pid'
    })
    expect(existsSync(pidPath)).toBe(true)
    pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
  })

  it('reclaims nothing for a packaged host with no asar root (orcad on win32)', () => {
    const root = getDaemonHostRootDir()
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    hostApp.appPath = join(installDir, 'resources', 'app')
    installHostApp()
    pruneOldDaemonHosts({ status: 'complete', versionLiveness: new Map() })
    // Node hosts do not own this Electron runtime layout and cannot authorize its cleanup.
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
  })
})

describe('collectPinnedDaemonVersions', () => {
  it('pins the app version of a live daemon pid file and skips dead ones', () => {
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      join(runtimeDir, 'daemon-v4.pid'),
      JSON.stringify({ pid: process.pid, startedAtMs: null, appVersion: '7.0.0' })
    )
    writeFileSync(
      join(runtimeDir, 'daemon-v3.pid'),
      JSON.stringify({ pid: 2147483646, startedAtMs: null, appVersion: '6.0.0' })
    )
    const pinned = collectPinnedDaemonVersions(runtimeDir)
    expect(pinned).toEqual({
      status: 'complete',
      versionLiveness: new Map([
        ['7.0.0', { status: 'live' }],
        ['6.0.0', { status: 'exited' }]
      ])
    })
  })
})
