import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureRuntimeMock, isDistroRunningMock, spawnMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  isDistroRunningMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./filesystem-watcher-wsl-runtime', () => ({
  ensureWslWatcherRuntime: ensureRuntimeMock,
  isWslDistroRunning: isDistroRunningMock,
  WslWatcherCompatibilityError: class WslWatcherCompatibilityError extends Error {}
}))

import { createWslWatcher } from './filesystem-watcher-wsl'
import type { WatchedRoot, WslWatcherDeps } from './filesystem-watcher-wsl'
import { resetWslWatcherHostsForTest } from './filesystem-watcher-wsl-host-client'
import { SNAPSHOT_END, SNAPSHOT_START } from './filesystem-watcher-wsl-snapshot'

const ROOT_KEY = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const SECOND_ROOT_KEY = '\\\\wsl.localhost\\Ubuntu\\home\\me\\other'

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdinData = ''
  kill = vi.fn(() => {
    this.emit('close', null, 'SIGTERM')
    return true
  })

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinData += chunk.toString('utf8')
    })
  }
}

function hostMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

function snapshotFrame(entries: [type: string, mtime: string, path: string][]): string {
  return `${SNAPSHOT_START}${entries
    .map(([type, mtime, entryPath]) => `${type}\t${mtime}\t${entryPath}\0`)
    .join('')}${SNAPSHOT_END}`
}

type ScheduleBatchFlush = (rootKey: string, root: WatchedRoot) => void

function makeDeps(
  scheduleBatchFlush = vi.fn<ScheduleBatchFlush>()
): WslWatcherDeps & { scheduleBatchFlush: ReturnType<typeof vi.fn<ScheduleBatchFlush>> } {
  return { ignoreDirs: ['node_modules', '.git'], scheduleBatchFlush }
}

function queueChildren(...children: FakeChildProcess[]): void {
  for (const child of children) {
    spawnMock.mockReturnValueOnce(child)
  }
}

async function readyHost(child: FakeChildProcess, ids = [1]): Promise<void> {
  child.stdout.write(hostMessage({ op: 'ready', protocol: 1 }))
  await vi.waitFor(() => expect(child.stdinData).toContain('"op":"subscribe"'))
  for (const id of ids) {
    child.stdout.write(hostMessage({ op: 'subscribed', id }))
  }
}

async function startNativeWatcher(
  deps = makeDeps()
): Promise<{ child: FakeChildProcess; root: WatchedRoot; deps: ReturnType<typeof makeDeps> }> {
  const child = new FakeChildProcess()
  queueChildren(child)
  const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, deps)
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
  await readyHost(child)
  return { child, root: await promise, deps }
}

describe('createWslWatcher', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    ensureRuntimeMock.mockReset().mockResolvedValue({
      nodePath: '/home/me/.local/share/orca/wsl-watcher/version/x64/node',
      hostPath: '/home/me/.local/share/orca/wsl-watcher/version/x64/host.js'
    })
    isDistroRunningMock.mockReset().mockResolvedValue(true)
  })

  afterEach(() => {
    resetWslWatcherHostsForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts Orca managed Linux events without Python or a distro Node dependency', async () => {
    const { child, root } = await startNativeWatcher()

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      [
        '-d',
        'Ubuntu',
        '--exec',
        '/home/me/.local/share/orca/wsl-watcher/version/x64/node',
        '/home/me/.local/share/orca/wsl-watcher/version/x64/host.js'
      ],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    )
    expect(child.stdinData).toContain('"dir":"/home/me/repo"')
    expect(child.stdinData).toContain('"ignoreDirs":["node_modules",".git"]')
    expect(child.stdinData).not.toContain('python')
    await root.subscription.unsubscribe()
  })

  it('streams nested native changes as UNC watcher events', async () => {
    const scheduleBatchFlush = vi.fn<ScheduleBatchFlush>()
    const { child, root } = await startNativeWatcher(makeDeps(scheduleBatchFlush))

    child.stdout.write(
      hostMessage({
        op: 'events',
        id: 1,
        events: [
          { type: 'update', path: '/home/me/repo/docs/deep/README.md' },
          { type: 'create', path: '/home/me/repo/new.txt' },
          { type: 'delete', path: '/home/me/repo/old.txt' },
          { type: 'update', path: '/home/me/repository/outside.txt' }
        ]
      })
    )

    expect(scheduleBatchFlush).toHaveBeenCalledOnce()
    expect(root.batch.events).toEqual([
      { type: 'update', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\docs\\deep\\README.md' },
      { type: 'create', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\new.txt' },
      { type: 'delete', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\old.txt' }
    ])
    await root.subscription.unsubscribe()
  })

  it('shares one Linux host across roots in the same distro', async () => {
    const child = new FakeChildProcess()
    queueChildren(child)
    const firstPromise = createWslWatcher(ROOT_KEY, ROOT_KEY, makeDeps())
    const secondPromise = createWslWatcher(SECOND_ROOT_KEY, SECOND_ROOT_KEY, makeDeps())
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    child.stdout.write(hostMessage({ op: 'ready', protocol: 1 }))
    await vi.waitFor(() => {
      expect(child.stdinData).toContain('"dir":"/home/me/repo"')
      expect(child.stdinData).toContain('"dir":"/home/me/other"')
    })
    child.stdout.write(hostMessage({ op: 'subscribed', id: 1 }))
    child.stdout.write(hostMessage({ op: 'subscribed', id: 2 }))
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    await first.subscription.unsubscribe()
    expect(child.kill).not.toHaveBeenCalled()
    await second.subscription.unsubscribe()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('uses recursive snapshots when the managed runtime is unavailable', async () => {
    ensureRuntimeMock.mockRejectedValueOnce(new Error('managed runtime unavailable'))
    const snapshot = new FakeChildProcess()
    queueChildren(snapshot)
    const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, makeDeps())
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    snapshot.stdout.write(snapshotFrame([]))
    const root = await promise

    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '-d',
      'Ubuntu',
      '--',
      'sh',
      '-s',
      '--',
      '/home/me/repo'
    ])
    expect(snapshot.stdinData).toContain('find "$root" -mindepth 1')
    expect(snapshot.stdinData).not.toContain('-maxdepth')
    await root.subscription.unsubscribe()
  })

  it('diffs fallback snapshots into create, update, and delete events', async () => {
    ensureRuntimeMock.mockRejectedValueOnce(new Error('managed runtime unavailable'))
    const scheduleBatchFlush = vi.fn<ScheduleBatchFlush>()
    const snapshot = new FakeChildProcess()
    queueChildren(snapshot)
    const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, makeDeps(scheduleBatchFlush))
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    snapshot.stdout.write(
      snapshotFrame([
        ['f', '1.0', '/home/me/repo/README.md'],
        ['f', '1.0', '/home/me/repo/old.txt']
      ])
    )
    const root = await promise
    snapshot.stdout.write(
      snapshotFrame([
        ['f', '2.0', '/home/me/repo/README.md'],
        ['f', '1.0', '/home/me/repo/new.txt']
      ])
    )

    expect(root.batch.events).toEqual([
      { type: 'update', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\README.md' },
      { type: 'create', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\new.txt' },
      { type: 'delete', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\old.txt' }
    ])
    await root.subscription.unsubscribe()
  })

  it('waits for an intentionally stopped distro before restarting', async () => {
    vi.useFakeTimers()
    isDistroRunningMock.mockResolvedValueOnce(false).mockResolvedValue(true)
    const scheduleBatchFlush = vi.fn<ScheduleBatchFlush>()
    const first = new FakeChildProcess()
    const second = new FakeChildProcess()
    queueChildren(first, second)
    const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, makeDeps(scheduleBatchFlush))
    await vi.advanceTimersByTimeAsync(0)
    await readyHost(first)
    const root = await promise

    first.emit('close', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(500)
    expect(spawnMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    await readyHost(second)

    expect(root.batch.overflowed).toBe(true)
    expect(scheduleBatchFlush).toHaveBeenCalledOnce()
    await root.subscription.unsubscribe()
  })

  it('kills the shared WSL host on the last unsubscribe without emitting a refresh', async () => {
    const scheduleBatchFlush = vi.fn<ScheduleBatchFlush>()
    const { child, root } = await startNativeWatcher(makeDeps(scheduleBatchFlush))

    await root.subscription.unsubscribe()

    expect(child.kill).toHaveBeenCalledOnce()
    expect(scheduleBatchFlush).not.toHaveBeenCalled()
  })

  it('rejects only after both managed native watching and snapshot startup fail', async () => {
    ensureRuntimeMock.mockRejectedValueOnce(new Error('managed runtime unavailable'))
    const snapshot = new FakeChildProcess()
    queueChildren(snapshot)
    const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, makeDeps())
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    snapshot.stderr.write('find failed')
    snapshot.emit('close', 1, null)

    await expect(promise).rejects.toThrow('WSL watcher exited before ready')
  })
})
