import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireHeavySuiteLock,
  getHeavySuiteLockPath,
  getHeavySuiteRecoveryGuardPath,
  isProcessTreeAlive,
  releaseHeavySuiteLock
} from './run-heavy-test-suite.mjs'

const testRoots = []

function createTestRoot() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-heavy-suite-lock-test-'))
  testRoots.push(testRoot)
  return testRoot
}

function writeOwner(lockPath, owner) {
  writeFileSync(lockPath, `${JSON.stringify(owner)}\n`)
}

afterEach(() => {
  for (const testRoot of testRoots.splice(0)) {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

describe('heavy test suite lock', () => {
  it('recovers a lock only when both recorded processes are dead', () => {
    const testRoot = createTestRoot()
    const lockPath = getHeavySuiteLockPath(testRoot)
    writeOwner(lockPath, {
      token: 'stale-token',
      ownerPid: 111,
      childPid: 222,
      phase: 'running',
      suite: 'unit',
      acquiredAt: new Date(0).toISOString()
    })

    const handle = acquireHeavySuiteLock({
      suite: 'electron-e2e',
      tempDir: testRoot,
      isOwnerAlive: () => false,
      isChildTreeAlive: () => false
    })

    expect(handle.owner.suite).toBe('electron-e2e')
    releaseHeavySuiteLock(handle)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('retries when the previous owner releases immediately after a publication conflict', () => {
    const testRoot = createTestRoot()
    const first = acquireHeavySuiteLock({ suite: 'unit', tempDir: testRoot })
    let released = false

    const second = acquireHeavySuiteLock({
      suite: 'electron-e2e',
      tempDir: testRoot,
      afterPublishConflict: () => {
        if (!released) {
          released = true
          expect(releaseHeavySuiteLock(first)).toBe(true)
        }
      }
    })

    expect(second.owner.suite).toBe('electron-e2e')
    expect(releaseHeavySuiteLock(second)).toBe(true)
  })

  it('never removes a successor published after an earlier stale observation', () => {
    const testRoot = createTestRoot()
    const lockPath = getHeavySuiteLockPath(testRoot)
    writeOwner(lockPath, {
      token: 'observed-stale-token',
      ownerPid: 111,
      childPid: null,
      phase: 'idle',
      suite: 'unit',
      acquiredAt: new Date(0).toISOString()
    })
    const successor = {
      token: 'live-successor-token',
      ownerPid: process.pid,
      childPid: null,
      phase: 'idle',
      suite: 'electron-e2e',
      acquiredAt: new Date().toISOString()
    }
    let replaced = false

    expect(() =>
      acquireHeavySuiteLock({
        suite: 'unit',
        tempDir: testRoot,
        isOwnerAlive: (pid) => pid === process.pid,
        isChildTreeAlive: () => false,
        beforeStaleRecovery: () => {
          if (!replaced) {
            replaced = true
            writeFileSync(lockPath, `${JSON.stringify(successor)}\n`)
          }
        }
      })
    ).toThrow(/already running/)
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe('live-successor-token')
    expect(existsSync(getHeavySuiteRecoveryGuardPath(lockPath))).toBe(false)
  })

  it('keeps a lock when its owner died but its child tree is alive', () => {
    const testRoot = createTestRoot()
    const lockPath = getHeavySuiteLockPath(testRoot)
    writeOwner(lockPath, {
      token: 'active-child-token',
      ownerPid: 111,
      childPid: 222,
      phase: 'running',
      suite: 'unit',
      acquiredAt: new Date().toISOString()
    })
    const ownerProbe = vi.fn(() => false)
    const childProbe = vi.fn(() => true)

    expect(() =>
      acquireHeavySuiteLock({
        suite: 'electron-e2e',
        tempDir: testRoot,
        isOwnerAlive: ownerProbe,
        isChildTreeAlive: childProbe
      })
    ).toThrow(/already running/)
    expect(ownerProbe).toHaveBeenCalledWith(111)
    expect(childProbe).toHaveBeenCalledWith(222)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('keeps a Windows lock when the recorded child died but an orphaned descendant remains', () => {
    const testRoot = createTestRoot()
    const lockPath = getHeavySuiteLockPath(testRoot)
    writeOwner(lockPath, {
      token: 'windows-orphan-token',
      ownerPid: 111,
      childPid: 222,
      phase: 'running',
      suite: 'electron-e2e',
      acquiredAt: new Date().toISOString()
    })
    const missingProcess = Object.assign(new Error('missing'), { code: 'ESRCH' })
    const killProcess = vi.fn(() => {
      throw missingProcess
    })
    const spawnProcessSync = vi.fn(() => ({
      status: 0,
      stdout: 'ORCA_DESCENDANT_ALIVE\n'
    }))

    expect(() =>
      acquireHeavySuiteLock({
        suite: 'unit',
        tempDir: testRoot,
        isOwnerAlive: () => false,
        isChildTreeAlive: (pid) =>
          isProcessTreeAlive(pid, { platform: 'win32', killProcess, spawnProcessSync })
      })
    ).toThrow(/already running/)
    expect(spawnProcessSync).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
      expect.objectContaining({ windowsHide: true })
    )
    expect(existsSync(lockPath)).toBe(true)
  })

  it('fails closed when Windows descendant inspection is unavailable', () => {
    const missingProcess = Object.assign(new Error('missing'), { code: 'ESRCH' })
    const spawnProcessSync = vi.fn(() => ({ error: new Error('PowerShell unavailable') }))

    expect(
      isProcessTreeAlive(222, {
        platform: 'win32',
        killProcess: () => {
          throw missingProcess
        },
        spawnProcessSync
      })
    ).toBe(true)
  })

  it('recovers a Windows tree only after a reliable snapshot reports no descendants', () => {
    const missingProcess = Object.assign(new Error('missing'), { code: 'ESRCH' })

    expect(
      isProcessTreeAlive(222, {
        platform: 'win32',
        killProcess: () => {
          throw missingProcess
        },
        spawnProcessSync: () => ({ status: 0, stdout: 'ORCA_NO_DESCENDANT\n' })
      })
    ).toBe(false)
  })

  it('preserves fresh malformed locks but recovers them after the grace period', () => {
    const testRoot = createTestRoot()
    const lockPath = getHeavySuiteLockPath(testRoot)
    writeFileSync(lockPath, '{broken')

    expect(() => acquireHeavySuiteLock({ suite: 'unit', tempDir: testRoot })).toThrow(
      /initializing or malformed/
    )

    const oldTime = new Date(Date.now() - 60_000)
    utimesSync(lockPath, oldTime, oldTime)
    const handle = acquireHeavySuiteLock({ suite: 'unit', tempDir: testRoot })
    releaseHeavySuiteLock(handle)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('never recursively removes a malformed lock directory', () => {
    const testRoot = createTestRoot()
    const lockPath = getHeavySuiteLockPath(testRoot)
    const sentinelPath = path.join(lockPath, 'user-owned-sentinel')
    mkdirSync(lockPath)
    writeFileSync(sentinelPath, 'preserve me')
    const oldTime = new Date(Date.now() - 60_000)
    utimesSync(lockPath, oldTime, oldTime)

    const acquire = () => acquireHeavySuiteLock({ suite: 'unit', tempDir: testRoot })
    expect(acquire).toThrow(/not a regular file/)
    expect(acquire).toThrow(path.basename(lockPath))
    expect(readFileSync(sentinelPath, 'utf8')).toBe('preserve me')
  })

  it('never releases a successor lock with the wrong token', () => {
    const testRoot = createTestRoot()
    const handle = acquireHeavySuiteLock({ suite: 'unit', tempDir: testRoot })

    expect(releaseHeavySuiteLock({ ...handle, token: 'wrong-token' })).toBe(false)
    expect(existsSync(handle.lockPath)).toBe(true)
    expect(releaseHeavySuiteLock(handle)).toBe(true)
  })

  it('deletes only its release tombstone when a successor acquires immediately', () => {
    const testRoot = createTestRoot()
    const handle = acquireHeavySuiteLock({ suite: 'unit', tempDir: testRoot })
    const successor = {
      token: 'successor-token',
      ownerPid: process.pid,
      childPid: null,
      phase: 'idle',
      suite: 'electron-e2e',
      acquiredAt: new Date().toISOString()
    }

    expect(
      releaseHeavySuiteLock(handle, {
        renameLock: (source, destination) => {
          renameSync(source, destination)
          writeOwner(handle.lockPath, successor)
        }
      })
    ).toBe(true)
    expect(JSON.parse(readFileSync(handle.lockPath, 'utf8')).token).toBe('successor-token')
  })
})
