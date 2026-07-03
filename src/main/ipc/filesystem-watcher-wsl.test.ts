import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { createWslWatcher } from './filesystem-watcher-wsl'
import type { WatchedRoot, WslWatcherDeps } from './filesystem-watcher-wsl'

const SNAPSHOT_START = '\x1e'
const SNAPSHOT_END = '\x1f'
const ROOT_KEY = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => {
    this.emit('close', null, 'SIGTERM')
    return true
  })
}

function snapshotFrame(entries: [type: string, mtime: string, path: string][]): string {
  return `${SNAPSHOT_START}${entries
    .map(([type, mtime, entryPath]) => `${type}\t${mtime}\t${entryPath}\0`)
    .join('')}${SNAPSHOT_END}`
}

type ScheduleBatchFlush = (rootKey: string, root: WatchedRoot) => void
type ScheduleBatchFlushMock = ReturnType<typeof vi.fn<ScheduleBatchFlush>>

function makeDeps(
  scheduleBatchFlush: ScheduleBatchFlushMock = vi.fn<ScheduleBatchFlush>()
): WslWatcherDeps & {
  scheduleBatchFlush: ScheduleBatchFlushMock
  watchedRoots: Map<string, WatchedRoot>
} {
  return {
    ignoreDirs: ['node_modules', '.git'],
    scheduleBatchFlush,
    watchedRoots: new Map()
  }
}

function startWatcher(deps = makeDeps()): {
  child: FakeChildProcess
  promise: Promise<WatchedRoot>
  deps: ReturnType<typeof makeDeps>
} {
  const child = new FakeChildProcess()
  spawnMock.mockReturnValueOnce(child)
  const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, deps)
  return { child, promise, deps }
}

async function resolveInitialSnapshot(
  child: FakeChildProcess,
  promise: Promise<WatchedRoot>
): Promise<WatchedRoot> {
  child.stdout.write(snapshotFrame([['f', '1.0', '/home/me/repo/README.md']]))
  return promise
}

describe('createWslWatcher', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('spawns a WSL-native snapshot process for the distro path', async () => {
    const { child, promise } = startWatcher()
    child.stdout.write(snapshotFrame([]))

    await promise

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'sh', '-s', '--', '/home/me/repo'],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    )
  })

  it('diffs WSL snapshots into create, update, and delete events', async () => {
    const scheduleBatchFlush = vi.fn()
    const { child, promise } = startWatcher(makeDeps(scheduleBatchFlush))

    child.stdout.write(
      snapshotFrame([
        ['f', '1.0', '/home/me/repo/README.md'],
        ['f', '1.0', '/home/me/repo/old.txt']
      ])
    )
    const root = await promise
    child.stdout.write(
      snapshotFrame([
        ['f', '2.0', '/home/me/repo/README.md'],
        ['f', '1.0', '/home/me/repo/new.txt']
      ])
    )

    expect(scheduleBatchFlush).toHaveBeenCalledOnce()
    expect(root.batch.events).toEqual([
      { type: 'update', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\README.md' },
      { type: 'create', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\new.txt' },
      { type: 'delete', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\old.txt' }
    ])
  })

  it('turns watcher exit into an overflow refresh without retaining UNC paths', async () => {
    const scheduleBatchFlush = vi.fn()
    const deps = makeDeps(scheduleBatchFlush)
    const { child, promise } = startWatcher(deps)
    const root = await resolveInitialSnapshot(child, promise)
    deps.watchedRoots.set(ROOT_KEY, root)

    child.emit('close', null, 'SIGTERM')

    expect(scheduleBatchFlush).toHaveBeenCalledOnce()
    expect(root.batch.events).toEqual([])
    expect(root.batch.overflowed).toBe(true)
    expect(deps.watchedRoots.has(ROOT_KEY)).toBe(false)
  })

  it('kills the WSL child on unsubscribe without emitting a shutdown refresh', async () => {
    const scheduleBatchFlush = vi.fn()
    const { child, promise } = startWatcher(makeDeps(scheduleBatchFlush))
    const root = await resolveInitialSnapshot(child, promise)

    await root.subscription.unsubscribe()

    expect(child.kill).toHaveBeenCalledOnce()
    expect(scheduleBatchFlush).not.toHaveBeenCalled()
  })

  it('rejects when the WSL process exits before the first snapshot', async () => {
    const { child, promise } = startWatcher()

    child.stderr.write('find failed')
    child.emit('close', 1, null)

    await expect(promise).rejects.toThrow('WSL watcher exited before first snapshot')
  })

  it('does not emit a shutdown refresh after a startup error', async () => {
    const scheduleBatchFlush = vi.fn()
    const { child, promise } = startWatcher(makeDeps(scheduleBatchFlush))

    child.emit('error', new Error('spawn failed'))
    child.emit('close', 1, null)

    await expect(promise).rejects.toThrow('spawn failed')
    expect(scheduleBatchFlush).not.toHaveBeenCalled()
  })

  it('rejects startup when WSL exits before reading the snapshot script', async () => {
    const { child, promise } = startWatcher()

    child.stdin.emit('error', new Error('write EPIPE'))

    await expect(promise).rejects.toThrow('write EPIPE')
  })
})
