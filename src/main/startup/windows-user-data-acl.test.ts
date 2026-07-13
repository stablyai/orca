import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureWindowsUserDataAclGrant,
  WINDOWS_ACL_GRANT_MARKER_FILE,
  WINDOWS_ACL_GRANT_SCHEME_VERSION,
  type WindowsAclGrantResult
} from './windows-user-data-acl'

type SpawnCall = { target: string; args: string[] }

const FAKE_CHILD_PID = 4242

function createFakeSpawn(exitCode: number): {
  calls: SpawnCall[]
  spawnFn: (command: string, args?: readonly string[], options?: unknown) => EventEmitter
} {
  const calls: SpawnCall[] = []
  return {
    calls,
    spawnFn: (_command: string, args: readonly string[] = []) => {
      calls.push({ target: args[0] ?? '', args: [...args] })
      const child = new EventEmitter() as EventEmitter & { kill: () => void; pid: number }
      child.kill = () => undefined
      child.pid = FAKE_CHILD_PID
      setImmediate(() => child.emit('exit', exitCode))
      return child
    }
  }
}

function awaitResult(
  userDataPath: string,
  options: Parameters<typeof ensureWindowsUserDataAclGrant>[1]
): Promise<WindowsAclGrantResult> {
  return new Promise((resolve) => {
    ensureWindowsUserDataAclGrant(userDataPath, { spawnDelayMs: 0, ...options, onDone: resolve })
  })
}

describe('ensureWindowsUserDataAclGrant', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-acl-test-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('grants children + root then writes the marker', async () => {
    const fake = createFakeSpawn(0)
    const result = await awaitResult(userDataPath, {
      identity: 'testuser',
      spawnFn: fake.spawnFn as never
    })
    expect(result).toEqual({ mode: 'granted' })
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0].target).toBe(join(userDataPath, '*'))
    expect(fake.calls[1].target).toBe(userDataPath)
    expect(fake.calls[0].args).toContain('testuser:(OI)(CI)(F)')
    const marker = JSON.parse(
      readFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), 'utf-8')
    )
    expect(marker.schemeVersion).toBe(WINDOWS_ACL_GRANT_SCHEME_VERSION)
    expect(marker.identity).toBe('testuser')
  })

  it('skips all spawns when the marker matches the identity', async () => {
    writeFileSync(
      join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE),
      JSON.stringify({
        schemeVersion: WINDOWS_ACL_GRANT_SCHEME_VERSION,
        identity: 'testuser',
        grantedAt: 1
      })
    )
    const fake = createFakeSpawn(0)
    const result = await awaitResult(userDataPath, {
      identity: 'testuser',
      spawnFn: fake.spawnFn as never
    })
    expect(result).toEqual({ mode: 'marker-hit' })
    expect(fake.calls).toHaveLength(0)
  })

  it('re-grants when the marker belongs to a different identity', async () => {
    writeFileSync(
      join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE),
      JSON.stringify({
        schemeVersion: WINDOWS_ACL_GRANT_SCHEME_VERSION,
        identity: 'someone-else',
        grantedAt: 1
      })
    )
    const fake = createFakeSpawn(0)
    const result = await awaitResult(userDataPath, {
      identity: 'testuser',
      spawnFn: fake.spawnFn as never
    })
    expect(result).toEqual({ mode: 'granted' })
    expect(fake.calls).toHaveLength(2)
  })

  it('does not write the marker when icacls fails, so the next launch retries', async () => {
    const fake = createFakeSpawn(5)
    const result = await awaitResult(userDataPath, {
      identity: 'testuser',
      spawnFn: fake.spawnFn as never
    })
    expect(result).toEqual({ mode: 'failed', reason: 'exit 5; exit 5' })
    expect(() => readFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE))).toThrow()
  })

  it('no-ops without a resolvable identity', async () => {
    const fake = createFakeSpawn(0)
    const result = await awaitResult(userDataPath, {
      identity: null,
      spawnFn: fake.spawnFn as never
    })
    expect(result).toEqual({ mode: 'no-identity' })
    expect(fake.calls).toHaveLength(0)
  })

  it('ignores a corrupt marker and re-grants', async () => {
    writeFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), '{not json')
    const fake = createFakeSpawn(0)
    const result = await awaitResult(userDataPath, {
      identity: 'testuser',
      spawnFn: fake.spawnFn as never
    })
    expect(result).toEqual({ mode: 'granted' })
  })

  it('drops each icacls child to idle CPU priority', async () => {
    const fake = createFakeSpawn(0)
    const priorityCalls: [number, number][] = []
    const result = await awaitResult(userDataPath, {
      identity: 'testuser',
      spawnFn: fake.spawnFn as never,
      setPriorityFn: (pid: number, priority: number) => {
        priorityCalls.push([pid, priority])
      }
    })
    expect(result).toEqual({ mode: 'granted' })
    expect(priorityCalls).toEqual([
      [FAKE_CHILD_PID, os.constants.priority.PRIORITY_LOW],
      [FAKE_CHILD_PID, os.constants.priority.PRIORITY_LOW]
    ])
  })

  it('still grants when setPriority throws', async () => {
    const fake = createFakeSpawn(0)
    const result = await awaitResult(userDataPath, {
      identity: 'testuser',
      spawnFn: fake.spawnFn as never,
      setPriorityFn: () => {
        throw new Error('EACCES')
      }
    })
    expect(result).toEqual({ mode: 'granted' })
    expect(fake.calls).toHaveLength(2)
  })

  it('defers the first-launch spawn by spawnDelayMs', async () => {
    vi.useFakeTimers()
    try {
      const fake = createFakeSpawn(0)
      let result: WindowsAclGrantResult | null = null
      ensureWindowsUserDataAclGrant(userDataPath, {
        identity: 'testuser',
        spawnFn: fake.spawnFn as never,
        spawnDelayMs: 10_000,
        onDone: (r) => {
          result = r
        }
      })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(fake.calls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(fake.calls.length).toBeGreaterThanOrEqual(1)
      await vi.runAllTimersAsync()
      expect(result).toEqual({ mode: 'granted' })
      expect(fake.calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not delay the marker-hit path', () => {
    writeFileSync(
      join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE),
      JSON.stringify({
        schemeVersion: WINDOWS_ACL_GRANT_SCHEME_VERSION,
        identity: 'testuser',
        grantedAt: 1
      })
    )
    const fake = createFakeSpawn(0)
    let result: WindowsAclGrantResult | null = null
    ensureWindowsUserDataAclGrant(userDataPath, {
      identity: 'testuser',
      spawnFn: fake.spawnFn as never,
      spawnDelayMs: 10_000,
      onDone: (r) => {
        result = r
      }
    })
    // onDone fires synchronously — no timer involved when the marker matches.
    expect(result).toEqual({ mode: 'marker-hit' })
    expect(fake.calls).toHaveLength(0)
  })
})
