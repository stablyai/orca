import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable Electron app stub, hoisted so the vi.mock factory closes over it.
const { electronApp } = vi.hoisted(() => ({
  electronApp: {
    isPackaged: true,
    userDataPath: '',
    version: '9.9.9',
    getPath: (): string => electronApp.userDataPath,
    getVersion: (): string => electronApp.version
  }
}))

vi.mock('electron', () => ({ app: electronApp }))

import {
  buildDaemonHostManifest,
  collectPinnedDaemonVersions,
  getRelocatedDaemonHost,
  materializeRelocatedDaemonHost,
  pruneOldDaemonHosts
} from './daemon-host-relocation'

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
  electronApp.isPackaged = true
  electronApp.userDataPath = userDataDir
  electronApp.version = '9.9.9'
  setProcessProp('platform', 'win32')
  setProcessProp('execPath', join(installDir, 'Orca.exe'))
  setProcessProp('resourcesPath', join(installDir, 'resources'))
})

afterEach(() => {
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

describe('pruneOldDaemonHosts', () => {
  it('removes unpinned non-current version dirs, keeping current and pinned', () => {
    const root = join(localAppDataDir, 'Orca', 'daemon-host')
    for (const v of ['9.9.9', '1.0.0', '2.0.0']) {
      mkdirSync(join(root, v), { recursive: true })
    }
    pruneOldDaemonHosts(new Set(['2.0.0']))
    expect(existsSync(join(root, '9.9.9'))).toBe(true)
    expect(existsSync(join(root, '2.0.0'))).toBe(true)
    expect(existsSync(join(root, '1.0.0'))).toBe(false)
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
    expect(pinned.has('7.0.0')).toBe(true)
    expect(pinned.has('6.0.0')).toBe(false)
  })
})
