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

import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'

// Mutable host stub. Relocation now reads the AppEnvironment port rather than electron's
// `app`, so orcad's daemon launch path can resolve without Electron in the graph.
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

import {
  buildDaemonHostManifest,
  collectPinnedDaemonVersions,
  getRelocatedDaemonHost,
  materializeRelocatedDaemonHost,
  pruneOldDaemonHosts,
  reclaimUnownedDaemonHostDir
} from './daemon-host-relocation'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'

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

// Build a win-unpacked fixture: exe + blobs + DLLs at root, daemon bundle and
// node-pty under resources, mirroring the packaged layout the copy expects.
function buildInstallFixture(root: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'Orca.exe'), 'exe-bytes')
  for (const name of ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']) {
    writeFileSync(join(root, name), name)
  }
  writeFileSync(join(root, 'ffmpeg.dll'), 'dll')
  writeFileSync(join(root, 'libEGL.dll'), 'dll')
  const mainDir = join(root, 'resources', 'app.asar.unpacked', 'out', 'main')
  mkdirSync(join(mainDir, 'chunks'), { recursive: true })
  writeFileSync(join(mainDir, 'daemon-entry.js'), 'entry')
  writeFileSync(join(mainDir, 'chunks', 'a.js'), 'chunk')
  writeFileSync(join(root, 'resources', 'app.asar.unpacked', 'out', 'package.json'), '{}')
  const nativeDir = join(root, 'resources', 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(nativeDir, { recursive: true })
  writeFileSync(join(nativeDir, 'conpty.node'), 'native')
  writeFileSync(join(nativeDir, 'conpty.pdb'), 'debug-symbols')
  mkdirSync(join(nativeDir, 'conpty'), { recursive: true })
  writeFileSync(join(nativeDir, 'conpty', 'conpty.dll'), 'conpty-dll')
  // Both win32 prebuilds exist in the packaged tree (build-time prune keeps the
  // `win32-` prefix); the copy filter keeps the host arch's and drops the other.
  const prebuildsRoot = join(root, 'resources', 'node_modules', 'node-pty', 'prebuilds')
  for (const arch of ['win32-x64', 'win32-arm64']) {
    mkdirSync(join(prebuildsRoot, arch), { recursive: true })
    writeFileSync(join(prebuildsRoot, arch, 'pty.node'), `${arch}-prebuild`)
  }
}

// The win32 prebuild dir the running host arch loads vs. the one that is pruned.
const HOST_PREBUILD = `win32-${process.arch}`
const OTHER_PREBUILD = HOST_PREBUILD === 'win32-arm64' ? 'win32-x64' : 'win32-arm64'

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
  // A test that fails between spyOn and mockRestore must not leak its mock into later tests.
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

describe('buildDaemonHostManifest', () => {
  it('mirrors the win-unpacked layout: exe + data blobs + resources tree, no GPU DLLs', () => {
    const appDir = 'C:\\app'
    const ops = buildDaemonHostManifest({
      appDir,
      execPath: 'C:\\app\\Orca.exe',
      resourcesPath: 'C:\\app\\resources',
      entrySourcePath: 'C:\\app\\resources\\app.asar.unpacked\\out\\main\\daemon-entry.js',
      entryRelPath: 'resources/app.asar.unpacked/out/main/daemon-entry.js'
    })
    const byDest = new Map(ops.map((op) => [op.destRel, op]))
    // The host exe is renamed to a distinct image name (NOT the source basename)
    // so the NSIS updater's name-based `taskkill /IM Orca.exe` can't kill it.
    expect(byDest.get('orca-terminal-daemon.exe')?.kind).toBe('file')
    expect(byDest.has('Orca.exe')).toBe(false)
    const exeOp = ops.find((op) => op.sourcePath === 'C:\\app\\Orca.exe')
    expect(exeOp?.destRel).not.toBe('Orca.exe')
    // V8/ICU data blobs are read by the Electron bootstrap and kept.
    expect(byDest.has('icudtl.dat')).toBe(true)
    // GPU/graphics DLLs are never loaded by the windowless host, so not copied.
    expect(byDest.has('ffmpeg.dll')).toBe(false)
    expect(byDest.has('libEGL.dll')).toBe(false)
    // Daemon bundle + node-pty mirrored at their real resources-relative paths.
    expect(byDest.get('resources/app.asar.unpacked/out/main/daemon-entry.js')?.kind).toBe('file')
    expect(byDest.get('resources/app.asar.unpacked/out/main/chunks')?.kind).toBe('dir')
    // node-pty is copied with a filter dropping .pdb + non-host-arch prebuilds.
    const nodePtyOp = byDest.get('resources/node_modules/node-pty')
    expect(nodePtyOp?.kind).toBe('dir')
    expect(nodePtyOp?.filter?.('node-pty/build/Release/conpty.node')).toBe(true)
    expect(nodePtyOp?.filter?.('node-pty/build/Release/conpty.pdb')).toBe(false)
    expect(nodePtyOp?.filter?.(`node-pty/prebuilds/${HOST_PREBUILD}/pty.node`)).toBe(true)
    expect(nodePtyOp?.filter?.(`node-pty/prebuilds/${OTHER_PREBUILD}/pty.node`)).toBe(false)
  })
})

describe('materializeRelocatedDaemonHost', () => {
  it('copies the tree, writes the marker, and returns mirrored fork paths', () => {
    const result = materializeRelocatedDaemonHost()
    expect(result).not.toBeNull()
    const dest = join(localAppDataDir, 'Orca', 'daemon-host', '9.9.9')
    expect(result?.execPath).toBe(join(dest, 'orca-terminal-daemon.exe'))
    expect(result?.entryPath).toBe(
      join(dest, 'resources', 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js')
    )
    expect(existsSync(result!.execPath)).toBe(true)
    expect(existsSync(result!.entryPath)).toBe(true)
    // node-pty native + conpty runtime copied at the require-resolvable path.
    expect(
      existsSync(
        join(dest, 'resources', 'node_modules', 'node-pty', 'build', 'Release', 'conpty.node')
      )
    ).toBe(true)
    expect(
      existsSync(join(dest, 'resources', 'app.asar.unpacked', 'out', 'main', 'chunks', 'a.js'))
    ).toBe(true)
    // Trim: GPU DLLs, .pdb debug symbols, and non-host-arch prebuilds excluded;
    // the host arch's prebuild is retained so node-pty resolves its native addon.
    expect(existsSync(join(dest, 'ffmpeg.dll'))).toBe(false)
    expect(existsSync(join(dest, 'libEGL.dll'))).toBe(false)
    expect(
      existsSync(
        join(dest, 'resources', 'node_modules', 'node-pty', 'build', 'Release', 'conpty.pdb')
      )
    ).toBe(false)
    const prebuildsDest = join(dest, 'resources', 'node_modules', 'node-pty', 'prebuilds')
    expect(existsSync(join(prebuildsDest, HOST_PREBUILD, 'pty.node'))).toBe(true)
    expect(existsSync(join(prebuildsDest, OTHER_PREBUILD, 'pty.node'))).toBe(false)
    // Marker records the version + entry rel path, written into the published dir.
    const marker = JSON.parse(readFileSync(join(dest, '.materialized.json'), 'utf8'))
    expect(marker.version).toBe('9.9.9')
    expect(marker.entryRelPath).toBe('resources/app.asar.unpacked/out/main/daemon-entry.js')
  })

  it('is idempotent: a valid marker short-circuits without recopying', () => {
    materializeRelocatedDaemonHost()
    const dest = join(localAppDataDir, 'Orca', 'daemon-host', '9.9.9')
    // A recopy would rm the dest; a sentinel inside it must survive the 2nd call.
    const sentinel = join(dest, 'sentinel.txt')
    writeFileSync(sentinel, 'keep')
    const result = materializeRelocatedDaemonHost()
    expect(result?.execPath).toBe(join(dest, 'orca-terminal-daemon.exe'))
    expect(existsSync(sentinel)).toBe(true)
  })

  it('fails open on a missing required input, leaving no dest or staging dir', () => {
    rmSync(join(installDir, 'resources', 'node_modules', 'node-pty'), {
      recursive: true,
      force: true
    })
    const result = materializeRelocatedDaemonHost()
    expect(result).toBeNull()
    const hostRoot = join(localAppDataDir, 'Orca', 'daemon-host')
    // Neither the published dest nor any leftover staging dir remains.
    const remaining = existsSync(hostRoot) ? readdirSync(hostRoot) : []
    expect(remaining).toEqual([])
  })

  it('returns null off win32', () => {
    setProcessProp('platform', 'darwin')
    expect(materializeRelocatedDaemonHost()).toBeNull()
    expect(existsSync(join(localAppDataDir, 'Orca', 'daemon-host'))).toBe(false)
  })

  it('does nothing for a packaged host with no asar root (orcad on win32)', () => {
    // orcad answers isPackaged() true — it is a shipped build — but it is plain Node: no
    // asar, no resourcesPath, and no NSIS updater to escape. Relocation staging a copy of
    // an Electron tree that is not there is the isPackaged-honesty defect, and it would
    // silently produce a null host on a path whose failures are meant to be visible.
    hostApp.appPath = join(installDir, 'resources', 'app')
    installHostApp()
    expect(materializeRelocatedDaemonHost()).toBeNull()
    expect(getRelocatedDaemonHost()).toBeNull()
    expect(existsSync(join(localAppDataDir, 'Orca', 'daemon-host'))).toBe(false)
  })
})

describe('getRelocatedDaemonHost', () => {
  it('returns null when the marker version does not match the current version', () => {
    const dest = join(localAppDataDir, 'Orca', 'daemon-host', '9.9.9')
    mkdirSync(dirname(join(dest, 'x')), { recursive: true })
    writeFileSync(join(dest, 'Orca.exe'), 'exe')
    mkdirSync(join(dest, 'resources', 'app.asar.unpacked', 'out', 'main'), { recursive: true })
    writeFileSync(
      join(dest, 'resources', 'app.asar.unpacked', 'out', 'main', 'daemon-entry.js'),
      'e'
    )
    writeFileSync(
      join(dest, '.materialized.json'),
      JSON.stringify({
        version: '8.8.8',
        completedAt: '',
        entryRelPath: 'resources/app.asar.unpacked/out/main/daemon-entry.js'
      })
    )
    expect(getRelocatedDaemonHost()).toBeNull()
  })
})

// Why: quarantine refuses records written in the last minute, because an in-flight publish is
// indistinguishable from a torn one. Age a record so it stands for a settled corrupt record.
function ageRecordPastQuarantineFloor(recordPath: string): void {
  const aged = new Date(Date.now() - 5 * 60_000)
  utimesSync(recordPath, aged, aged)
}

describe('pruneOldDaemonHosts', () => {
  it('removes unpinned non-current version dirs, keeping current and pinned', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
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
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
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
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
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

  it('prunes nothing and never throws when the evidence is unverifiable', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    for (const v of ['1.0.0', '2.0.0']) {
      mkdirSync(join(root, v), { recursive: true })
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      pruneOldDaemonHosts({
        status: 'unverifiable',
        reason: 'the daemon runtime directory could not be read'
      })
    ).not.toThrow()

    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    expect(existsSync(join(root, '2.0.0'))).toBe(true)
    // The reason must reach the field log — an unobservable no-op is undiagnosable.
    expect(warnSpy).toHaveBeenCalledWith(
      '[daemon] Skipping daemon-host prune: the daemon runtime directory could not be read'
    )
    warnSpy.mockRestore()
  })

  it('skips pruning when the runtime directory cannot be read', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
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
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '7.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // Two protocol generations of the same app version: one daemon live, one exited. The live
    // record must win the merged verdict whichever order the directory scan visits them.
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

  it('preserves a host dir for any verdict that is not positively exited', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    // Why: deliberate out-of-contract cast — deletion must require a positive 'exited' match,
    // so a future verdict status the prune does not know preserves the host dir, not deletes it.
    const futureVerdict = {
      status: 'suspended',
      reason: 'hypothetical future verdict'
    } as unknown as ProcessLivenessVerdict

    pruneOldDaemonHosts({
      status: 'complete',
      versionLiveness: new Map([['1.0.0', futureVerdict]])
    })
    expect(existsSync(join(root, '1.0.0'))).toBe(true)

    reclaimUnownedDaemonHostDir(futureVerdict, join(root, '1.0.0'))
    expect(existsSync(join(root, '1.0.0'))).toBe(true)

    reclaimUnownedDaemonHostDir({ status: 'exited' }, join(root, '1.0.0'))
    expect(existsSync(join(root, '1.0.0'))).toBe(false)
  })

  it('quarantines a record torn inside the pid digits without probing the truncated prefix', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // A tear inside the digits of pid 12345 leaves the prefix 123 — a DIFFERENT pid. Probing
    // it would attribute an unrelated (here: dead) process's verdict to this record; the
    // writer of a mid-digits tear died mid-write, so quarantine must not consult any probe.
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

  it('never lets an immortal-pid prefix turn a torn record into a permanent prune veto', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // Pid 41234 torn to the prefix 4 — the Windows System pid, which answers probes forever.
    // Trusting it would re-create for this one record the eternal veto pruning must not have.
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, '{"pid":4')
    ageRecordPastQuarantineFloor(pidPath)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('access denied'), { code: 'EPERM' })
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be parsed and was quarantined: daemon-v7.pid'
    })
    expect(killSpy).not.toHaveBeenCalled()
    expect(readFileSync(join(runtimeDir, 'daemon-v7.pid.corrupt'), 'utf8')).toBe('{"pid":4')

    // Next launch: the listing is complete again and the unowned host is reclaimed.
    pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
    expect(existsSync(join(root, '1.0.0'))).toBe(false)
    warnSpy.mockRestore()
    killSpy.mockRestore()
  })

  it('never quarantines a corrupt record that was just written', () => {
    // A live daemon's record is created before it is written (writeFileSync 'wx'), so a
    // concurrent launch can read it as empty. Quarantining it would strand the running daemon's
    // record and let the NEXT launch reclaim its host image.
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
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

  it('never treats a settled empty record as a valid pre-relocation daemon', () => {
    // Number('') === 0, so the parser's legacy bare-integer fallback accepts an empty record as
    // pid 0 with appVersion null. Skipping it as "pins no host dir" would leave the version
    // unpinned and let the prune below reclaim a live daemon's host image. Aged past the
    // quarantine floor so this pins the pid guard rather than the freshness guard.
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, '   ')
    ageRecordPastQuarantineFloor(pidPath)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be parsed and was quarantined: daemon-v7.pid'
    })
    pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('vetoes pruning while a pid salvaged from a corrupt record still answers', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    // A torn write preserves the pid prefix; the process behind it still answers, so the
    // record may belong to a live daemon of unknown version and must keep its veto un-quarantined.
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
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, 'not a daemon record')
    ageRecordPastQuarantineFloor(pidPath)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Launch with the corrupt record: prune skips once, and the record is quarantined in place
    // (bytes preserved) instead of vetoing every future launch.
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

    // Next launch: the listing is complete again and the unowned host is reclaimed.
    const nextEvidence = collectPinnedDaemonVersions(runtimeDir)
    expect(nextEvidence).toEqual({ status: 'complete', versionLiveness: new Map() })
    pruneOldDaemonHosts(nextEvidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(false)
    warnSpy.mockRestore()
  })

  it('vetoes pruning without quarantine when a pid record cannot be read', (ctx) => {
    // The suite mocks process.platform; the chmod trick needs the REAL host to be POSIX.
    if (originalPlatform === 'win32') {
      return ctx.skip()
    }
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = join(runtimeDir, 'daemon-v7.pid')
    writeFileSync(pidPath, JSON.stringify({ pid: 4242, startedAtMs: null, appVersion: '1.0.0' }))
    chmodSync(pidPath, 0o000)
    try {
      readFileSync(pidPath)
      return ctx.skip() // Running as root: the permission bit cannot make the read fail.
    } catch {
      // The read fails as intended.
    }

    const evidence = collectPinnedDaemonVersions(runtimeDir)

    // A read failure is transient (AV lock, vanished file): veto this launch, but leave the
    // record alone so a launch that can read it re-evaluates from the real bytes.
    expect(evidence).toEqual({
      status: 'unverifiable',
      reason: 'the daemon pid file could not be read: daemon-v7.pid'
    })
    expect(existsSync(pidPath)).toBe(true)
    pruneOldDaemonHosts(evidence)
    expect(existsSync(join(root, '1.0.0'))).toBe(true)
  })

  it('reclaims nothing for a packaged host with no asar root (orcad on win32)', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    mkdirSync(join(root, '1.0.0'), { recursive: true })
    hostApp.appPath = join(installDir, 'resources', 'app')
    installHostApp()
    pruneOldDaemonHosts({ status: 'complete', versionLiveness: new Map() })
    // A Node host owns no daemon-host tree, so deleting under it would be reaching into a
    // directory layout it never created.
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
