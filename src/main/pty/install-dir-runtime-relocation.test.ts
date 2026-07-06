import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDaemonPidPath, serializeDaemonPidFile } from '../daemon/daemon-spawner'
import type { DaemonPidFile } from '../daemon/daemon-spawner'
import {
  collectInUseRuntimeVersions,
  ensureRelocatedRuntime
} from './install-dir-runtime-relocation'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'install-dir-relocation-'))
})

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {}
})

// A generic runtime tree with a nested dir and a .pdb symbol file, to exercise
// recursive copy and the symbol-exclusion rule independent of any one runtime.
function seedSourceDir(dir: string): void {
  mkdirSync(join(dir, 'nested'), { recursive: true })
  writeFileSync(join(dir, 'runtime.exe'), 'host')
  writeFileSync(join(dir, 'runtime.dll'), 'lib')
  writeFileSync(join(dir, 'runtime.pdb'), 'symbols')
  writeFileSync(join(dir, 'nested', 'inner.bin'), 'inner')
}

// Writes a daemon pid file exactly as the daemon does (userData/daemon/daemon-v<N>.pid).
function writeDaemonPidFile(
  daemonRuntimeDir: string,
  protocolVersion: number,
  pidFile: DaemonPidFile
): void {
  mkdirSync(daemonRuntimeDir, { recursive: true })
  writeFileSync(
    getDaemonPidPath(daemonRuntimeDir, protocolVersion),
    serializeDaemonPidFile(pidFile)
  )
}

// Deterministic liveness that treats the given pids as running, so tests never
// depend on the host's real process table.
function aliveFor(...alivePids: number[]): (pid: number) => boolean {
  const set = new Set(alivePids)
  return (pid) => set.has(pid)
}

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

describe('ensureRelocatedRuntime', () => {
  it('copies the runtime tree (without symbols) and returns the version dir', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')

    const destDir = ensureRelocatedRuntime({
      sourceDir,
      destRoot,
      version: '1.2.3',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })

    expect(destDir).toBe(join(destRoot, '1.2.3'))
    expect(readFileSync(join(destDir!, 'runtime.exe'), 'utf8')).toBe('host')
    expect(readFileSync(join(destDir!, 'runtime.dll'), 'utf8')).toBe('lib')
    expect(readFileSync(join(destDir!, 'nested', 'inner.bin'), 'utf8')).toBe('inner')
    expect(existsSync(join(destDir!, 'runtime.pdb'))).toBe(false)
  })

  it('skips recopying once the completion marker exists', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    ensureRelocatedRuntime({
      sourceDir,
      destRoot,
      version: '1.2.3',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })

    writeFileSync(join(sourceDir, 'runtime.exe'), 'changed-after-first-copy')
    const destDir = ensureRelocatedRuntime({
      sourceDir,
      destRoot,
      version: '1.2.3',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })

    expect(readFileSync(join(destDir!, 'runtime.exe'), 'utf8')).toBe('host')
  })

  it('redoes an interrupted copy that has no completion marker', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    mkdirSync(join(destRoot, '1.2.3'), { recursive: true })
    writeFileSync(join(destRoot, '1.2.3', 'runtime.exe'), 'torn partial copy')

    const destDir = ensureRelocatedRuntime({
      sourceDir,
      destRoot,
      version: '1.2.3',
      daemonRuntimeDir: join(tempDir, 'daemon')
    })

    expect(readFileSync(join(destDir!, 'runtime.exe'), 'utf8')).toBe('host')
  })

  it('reclaims a stale version dir once no live daemon pins it', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    const daemonRuntimeDir = join(tempDir, 'daemon')
    ensureRelocatedRuntime({ sourceDir, destRoot, version: '1.0.0', daemonRuntimeDir })

    // The 1.0.0 daemon exited, so its pid is dead — nothing pins 1.0.0.
    writeDaemonPidFile(daemonRuntimeDir, 18, { pid: 4321, startedAtMs: null, appVersion: '1.0.0' })

    const destDir = ensureRelocatedRuntime({
      sourceDir,
      destRoot,
      version: '2.0.0',
      daemonRuntimeDir,
      isDaemonPidAlive: aliveFor(/* 4321 is dead */)
    })

    expect(destDir).toBe(join(destRoot, '2.0.0'))
    expect(existsSync(join(destRoot, '1.0.0'))).toBe(false)
    expect(existsSync(join(destRoot, '2.0.0', 'runtime.exe'))).toBe(true)
  })

  it('preserves a stale version dir a surviving daemon still pins', () => {
    const sourceDir = join(tempDir, 'source')
    seedSourceDir(sourceDir)
    const destRoot = join(tempDir, 'dest')
    const daemonRuntimeDir = join(tempDir, 'daemon')
    ensureRelocatedRuntime({ sourceDir, destRoot, version: '1.0.0', daemonRuntimeDir })

    // The 1.0.0 daemon survived the update and still loads its 1.0.0 runtime dir
    // on demand — deleting it would strand the running daemon.
    writeDaemonPidFile(daemonRuntimeDir, 18, { pid: 4321, startedAtMs: null, appVersion: '1.0.0' })

    const destDir = ensureRelocatedRuntime({
      sourceDir,
      destRoot,
      version: '2.0.0',
      daemonRuntimeDir,
      isDaemonPidAlive: aliveFor(4321)
    })

    expect(destDir).toBe(join(destRoot, '2.0.0'))
    expect(existsSync(join(destRoot, '1.0.0', 'runtime.exe'))).toBe(true)
    expect(existsSync(join(destRoot, '2.0.0', 'runtime.exe'))).toBe(true)
  })

  it('fails open when the source dir is missing', () => {
    expect(
      ensureRelocatedRuntime({
        sourceDir: join(tempDir, 'does-not-exist'),
        destRoot: join(tempDir, 'dest'),
        version: '1.2.3',
        daemonRuntimeDir: join(tempDir, 'daemon')
      })
    ).toBeNull()
  })
})
