import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { CompatibilityError, ensureRuntimeMock, isDistroRunningMock, spawnMock } = vi.hoisted(
  () => ({
    CompatibilityError: class WslWatcherCompatibilityError extends Error {},
    ensureRuntimeMock: vi.fn(),
    isDistroRunningMock: vi.fn(),
    spawnMock: vi.fn()
  })
)

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./filesystem-watcher-wsl-runtime', () => ({
  ensureWslWatcherRuntime: ensureRuntimeMock,
  isWslDistroRunning: isDistroRunningMock,
  WslWatcherCompatibilityError: CompatibilityError
}))

import { resetWslWatcherHostsForTest } from './filesystem-watcher-wsl-host-client'
import { SNAPSHOT_END, SNAPSHOT_START } from './filesystem-watcher-wsl-snapshot'
import { createWslWatcher, type WatchedRoot } from './filesystem-watcher-wsl'

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdinData = ''
  killed = false
  kill = vi.fn(() => {
    if (!this.killed) {
      this.killed = true
      this.emit('close', null, 'SIGTERM')
    }
    return true
  })

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinData += chunk.toString('utf8')
    })
  }
}

function writeMessage(child: FakeChildProcess, message: object): void {
  child.stdout.write(`${JSON.stringify(message)}\n`)
}

function subscriptionId(child: FakeChildProcess): number | undefined {
  for (const line of child.stdinData.split('\n')) {
    if (!line) {
      continue
    }
    const message = JSON.parse(line) as { op: string; id?: number }
    if (message.op === 'subscribe') {
      return message.id
    }
  }
  return undefined
}

async function makeNativeReady(child: FakeChildProcess): Promise<void> {
  writeMessage(child, { op: 'ready', protocol: 1 })
  await vi.waitFor(() => expect(subscriptionId(child)).toBeTypeOf('number'))
  writeMessage(child, { op: 'subscribed', id: subscriptionId(child) })
}

function createRoot(scheduleBatchFlush = vi.fn(), rootPath = ROOT): Promise<WatchedRoot> {
  return createWslWatcher(rootPath, rootPath, {
    ignoreDirs: ['node_modules', '.git'],
    scheduleBatchFlush
  })
}

async function waitForSpawnCount(count: number): Promise<void> {
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(count))
}

describe('WSL watcher recovery policy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
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

  it('reprobes native watching after a transient initial failure', async () => {
    ensureRuntimeMock.mockRejectedValueOnce(new Error('temporary install timeout'))
    const snapshot = new FakeChildProcess()
    const native = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(snapshot).mockReturnValueOnce(native)
    const rootPending = createRoot()
    await waitForSpawnCount(1)
    snapshot.stdout.write(`${SNAPSHOT_START}${SNAPSHOT_END}`)
    const root = await rootPending

    await vi.advanceTimersByTimeAsync(30_000)
    await waitForSpawnCount(2)
    expect(snapshot.kill).not.toHaveBeenCalled()
    await makeNativeReady(native)
    await vi.waitFor(() => expect(snapshot.kill).toHaveBeenCalledOnce())

    expect(ensureRuntimeMock).toHaveBeenCalledTimes(2)
    await root.subscription.unsubscribe()
  })

  it('uses an overflow barrier for snapshot mutations during native handoff', async () => {
    ensureRuntimeMock.mockRejectedValueOnce(new Error('temporary install timeout'))
    const snapshot = new FakeChildProcess()
    const native = new FakeChildProcess()
    const scheduleBatchFlush = vi.fn()
    spawnMock.mockReturnValueOnce(snapshot).mockReturnValueOnce(native)
    const rootPending = createRoot(scheduleBatchFlush)
    await waitForSpawnCount(1)
    snapshot.stdout.write(
      `${SNAPSHOT_START}regular file\t1\t/home/me/repo/file.md\0${SNAPSHOT_END}`
    )
    const root = await rootPending

    await vi.advanceTimersByTimeAsync(30_000)
    await waitForSpawnCount(2)
    snapshot.stdout.write(
      `${SNAPSHOT_START}regular file\t2\t/home/me/repo/file.md\0${SNAPSHOT_END}`
    )
    await vi.waitFor(() => expect(root.batch.events).toHaveLength(1))
    await makeNativeReady(native)

    await vi.waitFor(() => expect(root.batch.overflowed).toBe(true))
    expect(root.batch.events).toHaveLength(0)
    expect(scheduleBatchFlush).toHaveBeenCalledTimes(2)
    await root.subscription.unsubscribe()
  })

  it('cancels overlapping recovery starts when unsubscribed', async () => {
    ensureRuntimeMock.mockRejectedValueOnce(new Error('temporary install timeout'))
    const snapshot = new FakeChildProcess()
    const pendingNative = new FakeChildProcess()
    const replacementSnapshot = new FakeChildProcess()
    spawnMock
      .mockReturnValueOnce(snapshot)
      .mockReturnValueOnce(pendingNative)
      .mockReturnValueOnce(replacementSnapshot)
    const rootPending = createRoot()
    await waitForSpawnCount(1)
    snapshot.stdout.write(`${SNAPSHOT_START}${SNAPSHOT_END}`)
    const root = await rootPending

    await vi.advanceTimersByTimeAsync(30_000)
    await waitForSpawnCount(2)
    snapshot.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(500)
    await waitForSpawnCount(3)
    await root.subscription.unsubscribe()

    await vi.waitFor(() => expect(pendingNative.kill).toHaveBeenCalledOnce())
    expect(replacementSnapshot.kill).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawnMock).toHaveBeenCalledTimes(3)
  })

  it('cancels native startup through the owning install signal', async () => {
    const pendingNative = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(pendingNative)
    const abortController = new AbortController()
    const pending = createWslWatcher(ROOT, ROOT, {
      ignoreDirs: ['node_modules', '.git'],
      scheduleBatchFlush: vi.fn(),
      signal: abortController.signal
    })
    await waitForSpawnCount(1)

    abortController.abort()

    await expect(pending).rejects.toThrow('cancelled')
    expect(pendingNative.kill).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it('retries native after transient native and snapshot startup failures', async () => {
    const initialNative = new FakeChildProcess()
    const failedSnapshot = new FakeChildProcess()
    const retriedNative = new FakeChildProcess()
    ensureRuntimeMock
      .mockResolvedValueOnce({ nodePath: '/managed/node', hostPath: '/managed/host.js' })
      .mockRejectedValueOnce(new Error('temporary native bootstrap failure'))
      .mockResolvedValue({ nodePath: '/managed/node', hostPath: '/managed/host.js' })
    spawnMock
      .mockReturnValueOnce(initialNative)
      .mockReturnValueOnce(failedSnapshot)
      .mockReturnValueOnce(retriedNative)

    const rootPending = createRoot()
    await waitForSpawnCount(1)
    await makeNativeReady(initialNative)
    const root = await rootPending

    initialNative.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(500)
    await waitForSpawnCount(2)
    expect(spawnMock.mock.calls[1]?.[1]).toContain('sh')
    failedSnapshot.emit('close', 1, null)

    await vi.advanceTimersByTimeAsync(10_000)
    await waitForSpawnCount(3)
    expect(spawnMock.mock.calls[2]?.[1]).toContain('--exec')
    await makeNativeReady(retriedNative)
    await root.subscription.unsubscribe()
  })

  it('canonicalizes snapshot roots while preserving path case', async () => {
    ensureRuntimeMock.mockRejectedValueOnce(
      new CompatibilityError('managed WSL watcher requires a glibc distro')
    )
    const snapshot = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(snapshot)
    const noncanonical = '\\\\wsl.localhost\\Ubuntu\\home\\me\\Repo\\.\\nested\\..\\'
    const rootPending = createRoot(vi.fn(), noncanonical)
    await waitForSpawnCount(1)

    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '-d',
      'Ubuntu',
      '--',
      'sh',
      '-s',
      '--',
      '/home/me/Repo'
    ])
    snapshot.stdout.write(`${SNAPSHOT_START}${SNAPSHOT_END}`)
    const root = await rootPending
    await root.subscription.unsubscribe()
  })

  it('keeps permanently unsupported distros on the snapshot engine', async () => {
    ensureRuntimeMock.mockRejectedValue(
      new CompatibilityError('managed WSL watcher requires glibc >= 2.28')
    )
    const snapshot = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(snapshot)
    const rootPending = createRoot()
    await waitForSpawnCount(1)
    snapshot.stdout.write(`${SNAPSHOT_START}${SNAPSHOT_END}`)
    const root = await rootPending

    await vi.advanceTimersByTimeAsync(120_000)
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(ensureRuntimeMock).toHaveBeenCalledOnce()
    await root.subscription.unsubscribe()
  })

  it('does not re-probe a packaged build with a missing managed resource', async () => {
    // Why: the runtime layer wraps missing/corrupt bundles in the
    // compatibility error, which is the only permanent-failure signal.
    ensureRuntimeMock.mockRejectedValue(
      new CompatibilityError(
        'Unreadable managed WSL watcher bundle at C:\\Orca\\resources\\wsl-watcher'
      )
    )
    const snapshot = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(snapshot)
    const rootPending = createRoot()
    await waitForSpawnCount(1)
    snapshot.stdout.write(`${SNAPSHOT_START}${SNAPSHOT_END}`)
    const root = await rootPending

    await vi.advanceTimersByTimeAsync(120_000)
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(ensureRuntimeMock).toHaveBeenCalledOnce()
    await root.subscription.unsubscribe()
  })

  it('circuit-breaks unstable native hosts to snapshots and later reprobes', async () => {
    const first = new FakeChildProcess()
    const second = new FakeChildProcess()
    const third = new FakeChildProcess()
    const snapshot = new FakeChildProcess()
    const reprobe = new FakeChildProcess()
    spawnMock
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third)
      .mockReturnValueOnce(snapshot)
      .mockReturnValueOnce(reprobe)

    const rootPending = createRoot()
    await waitForSpawnCount(1)
    await makeNativeReady(first)
    const root = await rootPending

    first.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(500)
    await waitForSpawnCount(2)
    await makeNativeReady(second)
    second.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(1_000)
    await waitForSpawnCount(3)
    await makeNativeReady(third)
    third.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(2_000)
    await waitForSpawnCount(4)

    expect(spawnMock.mock.calls[3]?.[1]).toEqual([
      '-d',
      'Ubuntu',
      '--',
      'sh',
      '-s',
      '--',
      '/home/me/repo'
    ])
    snapshot.stdout.write(`${SNAPSHOT_START}${SNAPSHOT_END}`)
    await vi.advanceTimersByTimeAsync(30_000)
    await waitForSpawnCount(5)
    expect(snapshot.kill).not.toHaveBeenCalled()
    await makeNativeReady(reprobe)
    await vi.waitFor(() => expect(snapshot.kill).toHaveBeenCalledOnce())

    await root.subscription.unsubscribe()
  })

  it('restarts topology changes natively without tripping the circuit breaker', async () => {
    const children = Array.from({ length: 4 }, () => new FakeChildProcess())
    for (const child of children) {
      spawnMock.mockReturnValueOnce(child)
    }
    const scheduleBatchFlush = vi.fn()
    const rootPending = createRoot(scheduleBatchFlush)
    await waitForSpawnCount(1)
    await makeNativeReady(children[0]!)
    const root = await rootPending

    for (let index = 0; index < 3; index += 1) {
      const child = children[index]!
      writeMessage(child, {
        op: 'watch-error',
        id: subscriptionId(child),
        reason: 'topology',
        message: 'recursive topology changed'
      })
      await vi.advanceTimersByTimeAsync(500)
      await waitForSpawnCount(index + 2)
      expect(spawnMock.mock.calls[index + 1]?.[1]).toContain('--exec')
      await makeNativeReady(children[index + 1]!)
    }

    expect(spawnMock).toHaveBeenCalledTimes(4)
    expect(root.batch.overflowed).toBe(true)
    expect(scheduleBatchFlush).toHaveBeenCalled()
    await root.subscription.unsubscribe()
  })
})
