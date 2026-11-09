import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  spawnProcess: spawnMock
}))

import { createWslWatcher } from './filesystem-watcher-wsl'
import { resetWatcherChildRegistryForTest } from '../watcher-process/child-lifecycle/parcel-watcher-child-registry'
import type { WatchedRoot, WslWatcherDeps } from './filesystem-watcher-wsl'

const SNAPSHOT_START = '\0\x1e\0'
const SNAPSHOT_END = '\0\x1f\0'
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

type ScheduleBatchFlush = (root: WatchedRoot) => void
type ScheduleBatchFlushMock = ReturnType<typeof vi.fn<ScheduleBatchFlush>>

function makeDeps(
  scheduleBatchFlush: ScheduleBatchFlushMock = vi.fn<ScheduleBatchFlush>()
): WslWatcherDeps & {
  scheduleBatchFlush: ScheduleBatchFlushMock
  watchedRoots: Map<string, WatchedRoot>
} {
  return {
    ignoreDirs: ['node_modules', '.git'],
    ignoreDirSuffixes: ['.staging', '.asar'],
    scheduleBatchFlush,
    watchedRoots: new Map()
  }
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
    resetWatcherChildRegistryForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps unsubscribe pending until the WSL child physically closes', async () => {
    const child = new FakeChildProcess()
    child.kill = vi.fn(() => true)
    spawnMock.mockReturnValueOnce(child)
    const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, makeDeps())
    const root = await resolveInitialSnapshot(child, promise)

    let settled = false
    const unsubscribe = root.subscription.unsubscribe().finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    child.emit('close', null, 'SIGTERM')
    await unsubscribe
    expect(settled).toBe(true)
  })

  it('does not acknowledge startup abort before the WSL child closes', async () => {
    const child = new FakeChildProcess()
    child.kill = vi.fn(() => true)
    spawnMock.mockReturnValueOnce(child)
    const controller = new AbortController()
    const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, makeDeps(), controller.signal)

    controller.abort()
    let settled = false
    void promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    child.emit('close', null, 'SIGTERM')
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('applies the shared suffix exclusions to the snapshot script (#40204)', async () => {
    const child = new FakeChildProcess()
    child.kill = vi.fn(() => true)
    const chunks: string[] = []
    child.stdin.on('data', (chunk: Buffer) => chunks.push(String(chunk)))
    spawnMock.mockReturnValueOnce(child)
    const promise = createWslWatcher(ROOT_KEY, ROOT_KEY, makeDeps())
    const root = await resolveInitialSnapshot(child, promise)

    const script = chunks.join('')
    // The staging dir is pruned; a staged *.asar file is skipped instead of reported.
    expect(script).toContain("-name '*.staging'")
    expect(script).toContain("! -name '*.asar'")
    root.subscription.unsubscribe().catch(() => {})
  })
})
