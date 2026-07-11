import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyNativeEventsToSafetySnapshot,
  createBoundedProtocolWriter,
  reconcileWatcherSafetySnapshots,
  scanWatcherSafetySnapshot,
  watcherSafetyDelay,
  type SafetySnapshot
} from './wsl-watcher-host-safety'
import { resetWatcherHostFileSystemPermitsForTest } from './wsl-watcher-host-checkpoint'

const temporaryRoots: string[] = []

function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-wsl-host-safety-'))
  temporaryRoots.push(root)
  return root
}

async function completeSnapshot(root: string): Promise<SafetySnapshot> {
  const result = await scanWatcherSafetySnapshot(root, new Set())
  expect(result.kind).toBe('complete')
  return (result as Extract<typeof result, { kind: 'complete' }>).snapshot
}

class BackpressuredOutput extends EventEmitter {
  writes: string[] = []
  blockNextWrite = true

  write(line: string): boolean {
    this.writes.push(line)
    if (this.blockNextWrite) {
      this.blockNextWrite = false
      return false
    }
    return true
  }
}

afterEach(() => {
  resetWatcherHostFileSystemPermitsForTest()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('WSL watcher host safety', () => {
  it('requires a resubscribe when a populated directory moves into the root', async () => {
    const fixture = makeTemporaryRoot()
    const root = join(fixture, 'root')
    const source = join(fixture, 'source')
    mkdirSync(root)
    mkdirSync(join(source, 'nested'), { recursive: true })
    writeFileSync(join(source, 'nested', 'file.txt'), 'before')
    const snapshot = await completeSnapshot(root)

    const imported = join(root, 'imported')
    renameSync(source, imported)

    await expect(
      applyNativeEventsToSafetySnapshot(root, snapshot, [{ type: 'create', path: imported }])
    ).resolves.toBe('topology')
  })

  it('accepts empty directories but preserves the baseline across topology transitions', async () => {
    const root = makeTemporaryRoot()
    const file = join(root, 'entry')
    writeFileSync(file, 'file')
    const snapshot = await completeSnapshot(root)
    const fileBaseline = snapshot.get(file)

    unlinkSync(file)
    mkdirSync(file)
    await expect(
      applyNativeEventsToSafetySnapshot(root, snapshot, [{ type: 'update', path: file }])
    ).resolves.toBe('topology')
    expect(snapshot.get(file)).toEqual(fileBaseline)

    const empty = join(root, 'empty')
    mkdirSync(empty)
    await expect(
      applyNativeEventsToSafetySnapshot(root, snapshot, [{ type: 'create', path: empty }])
    ).resolves.toBe('applied')
    expect(snapshot.get(empty)?.directory).toBe(true)
  })

  it('detects directory inode replacement and retains known state on unknown stat errors', async () => {
    const root = makeTemporaryRoot()
    const directory = join(root, 'directory')
    mkdirSync(directory)
    const snapshot = await completeSnapshot(root)
    const baseline = snapshot.get(directory)

    renameSync(directory, join(root, 'old-directory'))
    mkdirSync(directory)
    await expect(
      applyNativeEventsToSafetySnapshot(root, snapshot, [{ type: 'update', path: directory }])
    ).resolves.toBe('topology')
    expect(snapshot.get(directory)).toEqual(baseline)

    const failing = join(root, 'failing')
    await expect(
      applyNativeEventsToSafetySnapshot(root, snapshot, [{ type: 'update', path: failing }], {
        fileSystem: {
          lstat: async () => {
            throw Object.assign(new Error('io failure'), { code: 'EIO' })
          },
          readdir: async () => []
        }
      })
    ).resolves.toBe('topology')
    expect(snapshot.get(directory)).toEqual(baseline)

    // Why: unreadable paths are invisible to safety scans, so events about
    // them must not interrupt the subscription the way unknown I/O does.
    const denied = join(root, 'denied')
    await expect(
      applyNativeEventsToSafetySnapshot(root, snapshot, [{ type: 'update', path: denied }], {
        fileSystem: {
          lstat: async () => {
            throw Object.assign(new Error('denied'), { code: 'EACCES' })
          },
          readdir: async () => []
        }
      })
    ).resolves.toBe('applied')
    expect(snapshot.has(denied)).toBe(false)
    expect(snapshot.get(directory)).toEqual(baseline)
  })

  it('scans past unreadable subtrees instead of failing the subscription', async () => {
    const root = makeTemporaryRoot()
    const locked = join(root, 'locked')
    const blocked = join(root, 'blocked.md')
    const readable = join(root, 'readable.md')
    mkdirSync(locked)
    writeFileSync(join(locked, 'secret.md'), 'hidden')
    writeFileSync(blocked, 'lstat denied')
    writeFileSync(readable, 'fine')
    const { lstat, readdir } = await import('node:fs/promises')
    const denied = (): Promise<never> =>
      Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const result = await scanWatcherSafetySnapshot(root, new Set(), {
      fileSystem: {
        lstat: (path) => (path === blocked ? denied() : lstat(path)),
        readdir: (path) => (path === locked ? denied() : readdir(path, { withFileTypes: true }))
      }
    })

    expect(result.kind).toBe('complete')
    const snapshot = (result as Extract<typeof result, { kind: 'complete' }>).snapshot
    expect(snapshot.has(readable)).toBe(true)
    expect(snapshot.get(locked)?.directory).toBe(true)
    expect(snapshot.has(join(locked, 'secret.md'))).toBe(false)
    expect(snapshot.has(blocked)).toBe(false)
  })

  it('bounds asynchronous native-event inspection without committing partial state', async () => {
    const snapshot: SafetySnapshot = new Map([
      ['/repo', { directory: true, signature: 'd:1' }],
      ['/repo/known', { directory: false, signature: 'f:known' }]
    ])
    const never = new Promise<never>(() => undefined)

    await expect(
      applyNativeEventsToSafetySnapshot(
        '/repo',
        snapshot,
        [
          { type: 'delete', path: '/repo/known' },
          { type: 'update', path: '/repo/stuck' }
        ],
        {
          maxDurationMs: 10,
          fileSystem: { lstat: async () => never, readdir: async () => never }
        }
      )
    ).resolves.toBe('topology')
    expect(snapshot.get('/repo/known')).toEqual({ directory: false, signature: 'f:known' })
  })

  it('recovers file events hidden by an inotify queue overflow', async () => {
    const root = makeTemporaryRoot()
    const file = join(root, 'README.md')
    writeFileSync(file, 'before')
    const previous = await completeSnapshot(root)

    writeFileSync(file, 'after-with-a-different-size')
    const next = await completeSnapshot(root)

    expect(reconcileWatcherSafetySnapshots(previous, next)).toEqual({
      events: [{ type: 'update', path: file }],
      topologyChanged: false
    })
  })

  it('bounds scans, cancels promptly, and adapts jittered cadence to event risk', async () => {
    const root = makeTemporaryRoot()
    writeFileSync(join(root, 'one'), '1')
    writeFileSync(join(root, 'two'), '2')

    await expect(scanWatcherSafetySnapshot(root, new Set(), { maxEntries: 1 })).resolves.toEqual({
      kind: 'entry-limit'
    })
    let clock = 0
    await expect(
      scanWatcherSafetySnapshot(root, new Set(), {
        maxDurationMs: 1,
        now: () => (clock += 2)
      })
    ).resolves.toEqual({ kind: 'time-limit' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      scanWatcherSafetySnapshot(root, new Set(), { signal: aborted.signal })
    ).resolves.toEqual({ kind: 'cancelled' })

    expect(watcherSafetyDelay('/repo-a', 1_000, 0)).toBeLessThan(6_100)
    expect(watcherSafetyDelay('/repo-a', 1, 0)).toBeGreaterThan(23_000)
    expect(watcherSafetyDelay('/repo-a', 0, 3)).toBeGreaterThan(230_000)
    expect(watcherSafetyDelay('/repo-a', 0, 1)).not.toBe(watcherSafetyDelay('/repo-b', 0, 1))
  })

  it('releases scan capacity when filesystem operations never settle', async () => {
    const root = makeTemporaryRoot()
    const never = new Promise<never>(() => undefined)
    const stuckFileSystem = {
      lstat: async () => never,
      readdir: async () => never
    }
    const first = scanWatcherSafetySnapshot('/stuck-a', new Set(), {
      fileSystem: stuckFileSystem,
      maxDurationMs: 20
    })
    const second = scanWatcherSafetySnapshot('/stuck-b', new Set(), {
      fileSystem: stuckFileSystem,
      maxDurationMs: 20
    })
    const progressing = scanWatcherSafetySnapshot(root, new Set(), { maxResourceWaitMs: 500 })

    await expect(first).resolves.toEqual({ kind: 'time-limit' })
    await expect(second).resolves.toEqual({ kind: 'time-limit' })
    await expect(progressing).resolves.toMatchObject({ kind: 'complete' })

    const controller = new AbortController()
    const cancelled = scanWatcherSafetySnapshot('/stuck-c', new Set(), {
      fileSystem: stuckFileSystem,
      maxDurationMs: 10_000,
      signal: controller.signal
    })
    controller.abort()
    await expect(cancelled).resolves.toEqual({ kind: 'cancelled' })
  })

  it('admits three or more queued roots in FIFO order without resource rejection', async () => {
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const fileSystem = {
      lstat: (path: string) =>
        new Promise<Stats>((resolve) => {
          started.push(path)
          releases.set(path, () => resolve({ isDirectory: () => false } as never))
        }),
      readdir: async () => []
    }
    const scans = ['/one', '/two', '/three', '/four'].map((root) =>
      scanWatcherSafetySnapshot(root, new Set(), {
        fileSystem,
        maxDurationMs: 1_000,
        maxResourceWaitMs: 1
      })
    )
    await vi.waitFor(() => expect(started).toEqual(['/one', '/two']))
    releases.get('/one')?.()
    await vi.waitFor(() => expect(started).toEqual(['/one', '/two', '/three']))
    releases.get('/two')?.()
    await vi.waitFor(() => expect(started).toEqual(['/one', '/two', '/three', '/four']))
    releases.get('/three')?.()
    releases.get('/four')?.()

    await expect(Promise.all(scans)).resolves.toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ kind: 'complete' }))
    )
  })

  it('caps physical operations across repeated scans whose I/O never settles', async () => {
    const lstat = vi.fn(() => new Promise<never>(() => undefined))
    const scans = Array.from({ length: 20 }, (_, index) =>
      scanWatcherSafetySnapshot(`/stuck-${index}`, new Set(), {
        fileSystem: { lstat, readdir: async () => [] },
        maxDurationMs: 5
      })
    )

    await Promise.all(scans)
    expect(lstat).toHaveBeenCalledTimes(8)
  })

  it('orders protocol messages across backpressure and exits at the memory cap', () => {
    const output = new BackpressuredOutput()
    const exit = vi.fn()
    const send = createBoundedProtocolWriter(output, exit)
    send({ op: 'first' })
    send({ op: 'second' })

    expect(output.writes).toHaveLength(1)
    output.emit('drain')
    expect(output.writes.map((line) => JSON.parse(line))).toEqual([
      { op: 'first' },
      { op: 'second' }
    ])

    const cappedOutput = new BackpressuredOutput()
    const cappedExit = vi.fn()
    const cappedSend = createBoundedProtocolWriter(cappedOutput, cappedExit)
    cappedSend({ payload: 'x'.repeat(4 * 1024 * 1024) })
    expect(cappedExit).toHaveBeenCalledWith(3)
    expect(cappedOutput.writes).toHaveLength(0)
  })
})
