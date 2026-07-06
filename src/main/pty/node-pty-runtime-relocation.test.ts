import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/unused'),
    getVersion: vi.fn(() => '0.0.0-test')
  }
}))

import { getDaemonPidPath, serializeDaemonPidFile } from '../daemon/daemon-spawner'
import type { DaemonPidFile } from '../daemon/daemon-spawner'
import {
  collectInUseRuntimeVersions,
  ensureRelocatedNodePtyNativeRuntime,
  resolveNodePtyNativeSourceDir
} from './node-pty-runtime-relocation'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'node-pty-relocation-'))
})

afterEach(() => {
  // Why: the loader-override test dlopens conpty.node from tempDir, and a
  // loaded native module stays image-locked until the process exits.
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {}
})

function seedSourceDir(dir: string): void {
  mkdirSync(join(dir, 'conpty'), { recursive: true })
  writeFileSync(join(dir, 'conpty.node'), 'binding')
  writeFileSync(join(dir, 'conpty_console_list.node'), 'listing')
  writeFileSync(join(dir, 'pty.node'), 'winpty-binding')
  writeFileSync(join(dir, 'winpty-agent.exe'), 'agent')
  writeFileSync(join(dir, 'conpty.pdb'), 'symbols')
  writeFileSync(join(dir, 'conpty', 'conpty.dll'), 'dll')
  writeFileSync(join(dir, 'conpty', 'OpenConsole.exe'), 'console-host')
}

// Writes a daemon pid file exactly as the daemon does (userData/daemon/daemon-v<N>.pid).
function writeDaemonPidFile(
  daemonRuntimeDir: string,
  protocolVersion: number,
  pidFile: DaemonPidFile
): void {
  mkdirSync(daemonRuntimeDir, { recursive: true })
  writeFileSync(getDaemonPidPath(daemonRuntimeDir, protocolVersion), serializeDaemonPidFile(pidFile))
}

// Deterministic liveness that treats the given pids as running, so tests never
// depend on the host's real process table.
function aliveFor(...alivePids: number[]): (pid: number) => boolean {
  const set = new Set(alivePids)
  return (pid) => set.has(pid)
}

describe('resolveNodePtyNativeSourceDir', () => {
  it('prefers the rebuilt build/Release binding over prebuilds', () => {
    const pkg = join(tempDir, 'node-pty')
    mkdirSync(join(pkg, 'build', 'Release'), { recursive: true })
    mkdirSync(join(pkg, 'prebuilds', `win32-${process.arch}`), { recursive: true })
    writeFileSync(join(pkg, 'build', 'Release', 'conpty.node'), 'x')
    writeFileSync(join(pkg, 'prebuilds', `win32-${process.arch}`, 'conpty.node'), 'x')
    expect(resolveNodePtyNativeSourceDir(pkg)).toBe(join(pkg, 'build', 'Release'))
  })

  it('falls back to the platform prebuild dir', () => {
    const pkg = join(tempDir, 'node-pty')
    mkdirSync(join(pkg, 'prebuilds', `win32-${process.arch}`), { recursive: true })
    writeFileSync(join(pkg, 'prebuilds', `win32-${process.arch}`, 'conpty.node'), 'x')
    expect(resolveNodePtyNativeSourceDir(pkg)).toBe(join(pkg, 'prebuilds', `win32-${process.arch}`))
  })

  it('returns null when no conpty binding exists', () => {
    const pkg = join(tempDir, 'node-pty')
    mkdirSync(join(pkg, 'build', 'Release'), { recursive: true })
    expect(resolveNodePtyNativeSourceDir(pkg)).toBeNull()
  })
})

describe('collectInUseRuntimeVersions', () => {
  it('returns an empty set when the daemon dir does not exist', () => {
    expect(collectInUseRuntimeVersions(join(tempDir, 'no-daemon-dir')).size).toBe(0)
  })

  it('collects the app version a live daemon pins', () => {
    const daemonDir = join(tempDir, 'daemon')
    writeDaemonPidFile(daemonDir, 18, { pid: 4321, startedAtMs: null, appVersion: '1.4.124-rc.1' })

    const inUse = collectInUseRuntimeVersions(daemonDir, aliveFor(4321))

    expect([...inUse]).toEqual(['1.4.124-rc.1'])
  })

  it('omits the version of a daemon whose pid is dead', () => {
    const daemonDir = join(tempDir, 'daemon')
    writeDaemonPidFile(daemonDir, 18, { pid: 4321, startedAtMs: null, appVersion: '1.4.124-rc.1' })

    const inUse = collectInUseRuntimeVersions(daemonDir, aliveFor(/* nobody */))

    expect(inUse.size).toBe(0)
  })

  it('collects one version per live daemon across protocol versions', () => {
    const daemonDir = join(tempDir, 'daemon')
    writeDaemonPidFile(daemonDir, 18, { pid: 100, startedAtMs: null, appVersion: '1.4.124-rc.1' })
    writeDaemonPidFile(daemonDir, 19, { pid: 200, startedAtMs: null, appVersion: '1.4.124-rc.2' })

    const inUse = collectInUseRuntimeVersions(daemonDir, aliveFor(100, 200))

    expect([...inUse].sort()).toEqual(['1.4.124-rc.1', '1.4.124-rc.2'])
  })

  it('ignores a daemon whose pid file records no app version', () => {
    const daemonDir = join(tempDir, 'daemon')
    // Pre-relocation daemon: JSON pid file without appVersion.
    writeDaemonPidFile(daemonDir, 18, { pid: 4321, startedAtMs: null })
    // Legacy daemon: bare-integer pid file (appVersion parses to null).
    mkdirSync(daemonDir, { recursive: true })
    writeFileSync(getDaemonPidPath(daemonDir, 17), '9999')

    const inUse = collectInUseRuntimeVersions(daemonDir, aliveFor(4321, 9999))

    expect(inUse.size).toBe(0)
  })

  it('ignores non-pid files in the daemon dir', () => {
    const daemonDir = join(tempDir, 'daemon')
    mkdirSync(daemonDir, { recursive: true })
    writeFileSync(join(daemonDir, 'daemon-v18.token'), 'secret')
    writeFileSync(join(daemonDir, 'daemon-v18.sock'), 'x')
    writeFileSync(join(daemonDir, 'notes.txt'), 'x')

    expect(collectInUseRuntimeVersions(daemonDir, aliveFor(1, 2, 3)).size).toBe(0)
  })

  it('skips a malformed pid file without throwing', () => {
    const daemonDir = join(tempDir, 'daemon')
    mkdirSync(daemonDir, { recursive: true })
    writeFileSync(getDaemonPidPath(daemonDir, 18), 'not-a-pid-at-all')
    writeDaemonPidFile(daemonDir, 19, { pid: 200, startedAtMs: null, appVersion: '2.0.0' })

    const inUse = collectInUseRuntimeVersions(daemonDir, aliveFor(200))

    expect([...inUse]).toEqual(['2.0.0'])
  })

  it('treats the current process as alive under the default liveness probe', () => {
    const daemonDir = join(tempDir, 'daemon')
    // startedAtMs null so startTimeMatches short-circuits true on every platform.
    writeDaemonPidFile(daemonDir, 18, {
      pid: process.pid,
      startedAtMs: null,
      appVersion: '3.0.0'
    })

    expect([...collectInUseRuntimeVersions(daemonDir)]).toEqual(['3.0.0'])
  })
})

describe('ensureRelocatedNodePtyNativeRuntime', () => {
  it('copies the runtime tree (without symbols) and returns the version dir', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')

    const destDir = ensureRelocatedNodePtyNativeRuntime({
      sourceDir,
      destRoot,
      version: '1.2.3',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })

    expect(destDir).toBe(join(destRoot, '1.2.3'))
    expect(readFileSync(join(destDir!, 'conpty.node'), 'utf8')).toBe('binding')
    expect(readFileSync(join(destDir!, 'conpty', 'OpenConsole.exe'), 'utf8')).toBe('console-host')
    expect(readFileSync(join(destDir!, 'conpty', 'conpty.dll'), 'utf8')).toBe('dll')
    expect(existsSync(join(destDir!, 'conpty.pdb'))).toBe(false)
  })

  it('skips recopying once the completion marker exists', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    ensureRelocatedNodePtyNativeRuntime({
      sourceDir,
      destRoot,
      version: '1.2.3',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })

    writeFileSync(join(sourceDir, 'conpty.node'), 'changed-after-first-copy')
    const destDir = ensureRelocatedNodePtyNativeRuntime({
      sourceDir,
      destRoot,
      version: '1.2.3',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })

    expect(readFileSync(join(destDir!, 'conpty.node'), 'utf8')).toBe('binding')
  })

  it('redoes an interrupted copy that has no completion marker', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    mkdirSync(join(destRoot, '1.2.3'), { recursive: true })
    writeFileSync(join(destRoot, '1.2.3', 'conpty.node'), 'torn partial copy')

    const destDir = ensureRelocatedNodePtyNativeRuntime({
      sourceDir,
      destRoot,
      version: '1.2.3',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })

    expect(readFileSync(join(destDir!, 'conpty.node'), 'utf8')).toBe('binding')
  })

  it('reclaims a stale version dir once no live daemon pins it', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    const daemonRuntimeDir = join(tempDir, 'daemon')
    ensureRelocatedNodePtyNativeRuntime({ sourceDir, destRoot, version: '1.0.0', daemonRuntimeDir })

    // The 1.0.0 daemon exited, so its pid is dead — nothing pins 1.0.0.
    writeDaemonPidFile(daemonRuntimeDir, 18, { pid: 4321, startedAtMs: null, appVersion: '1.0.0' })

    const destDir = ensureRelocatedNodePtyNativeRuntime({
      sourceDir,
      destRoot,
      version: '2.0.0',
      daemonRuntimeDir,
      isDaemonPidAlive: aliveFor(/* 4321 is dead */)
    })

    expect(destDir).toBe(join(destRoot, '2.0.0'))
    expect(existsSync(join(destRoot, '1.0.0'))).toBe(false)
    expect(existsSync(join(destRoot, '2.0.0', 'conpty.node'))).toBe(true)
  })

  it('preserves a stale version dir a surviving daemon still pins', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    const daemonRuntimeDir = join(tempDir, 'daemon')
    ensureRelocatedNodePtyNativeRuntime({ sourceDir, destRoot, version: '1.0.0', daemonRuntimeDir })

    // The 1.0.0 daemon survived the update and still loads conpty.dll from its
    // 1.0.0 runtime dir on every new spawn — deleting it would strand it.
    writeDaemonPidFile(daemonRuntimeDir, 18, { pid: 4321, startedAtMs: null, appVersion: '1.0.0' })

    const destDir = ensureRelocatedNodePtyNativeRuntime({
      sourceDir,
      destRoot,
      version: '2.0.0',
      daemonRuntimeDir,
      isDaemonPidAlive: aliveFor(4321)
    })

    expect(destDir).toBe(join(destRoot, '2.0.0'))
    expect(existsSync(join(destRoot, '1.0.0', 'conpty.node'))).toBe(true)
    expect(existsSync(join(destRoot, '2.0.0', 'conpty.node'))).toBe(true)
  })

  it('fails open when the source dir is missing', () => {
    expect(
      ensureRelocatedNodePtyNativeRuntime({
        sourceDir: join(tempDir, 'does-not-exist'),
        destRoot: join(tempDir, 'dest'),
        version: '1.2.3',
        daemonRuntimeDir: join(tempDir, 'daemon')
      })
    ).toBeNull()
  })
})

// Loads the real win32 conpty binding, so it cannot run on other platforms.
describe.runIf(process.platform === 'win32')('patched node-pty loader override', () => {
  it('loads the conpty binding from ORCA_NODE_PTY_NATIVE_DIR', () => {
    const requireFromHere = createRequire(import.meta.url)
    const nodePtyPackageDir = dirname(requireFromHere.resolve('node-pty/package.json'))
    const sourceDir = resolveNodePtyNativeSourceDir(nodePtyPackageDir)
    expect(sourceDir).not.toBeNull()

    const destDir = ensureRelocatedNodePtyNativeRuntime({
      sourceDir: sourceDir!,
      destRoot: join(tempDir, 'relocated-runtime'),
      version: 'loader-test',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })
    expect(destDir).not.toBeNull()

    const previousNativeDir = process.env.ORCA_NODE_PTY_NATIVE_DIR
    process.env.ORCA_NODE_PTY_NATIVE_DIR = destDir!
    try {
      const utils = requireFromHere('node-pty/lib/utils.js')
      const loaded = utils.loadNativeModule('conpty')
      expect(loaded.dir).toBe(destDir)
      expect(typeof loaded.module.startProcess).toBe('function')
    } finally {
      if (previousNativeDir === undefined) {
        delete process.env.ORCA_NODE_PTY_NATIVE_DIR
      } else {
        process.env.ORCA_NODE_PTY_NATIVE_DIR = previousNativeDir
      }
    }
  })
})
