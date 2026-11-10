import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeViaWatcherProcess } from '../ipc/filesystem/watcher-process/parcel-watcher-process'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from '../ipc/filesystem/watcher-process/parcel-watcher-process-subscription'
import { pluginDevChangeCount, pluginFrameContentRevision } from './plugin-dev-revision'

import { PluginServiceHousekeeping } from './plugin-service-housekeeping'

vi.mock('../ipc/filesystem/watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))

type NativeWatch = { callback: WatcherProcessCallback; hooks: WatcherProcessHooks }
type NativeSubscription = NativeWatch & { root: string; shallow: boolean; live: boolean }
const nativeWatches = new Map<string, NativeWatch>()
let subscribeLog: NativeSubscription[] = []
// Roots whose native registration rejects although the directory exists (e.g. unreachable UNC).
const rejectingRoots = new Set<string>()
const originalPlatform = process.platform
let fixture: string
let healthy: string
let failing: string
let housekeeping: PluginServiceHousekeeping
let options: Parameters<PluginServiceHousekeeping['sync']>[0]

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'orca-plugin-root-recovery-'))
  healthy = join(fixture, 'healthy')
  failing = join(fixture, 'failing')
  await Promise.all([mkdir(healthy), mkdir(failing)])
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  nativeWatches.clear()
  subscribeLog = []
  rejectingRoots.clear()
  vi.mocked(subscribeViaWatcherProcess).mockImplementation(
    (root, callback, watchOptions, hooks = {}) => {
      if (!existsSync(root) || rejectingRoots.has(root)) {
        return Promise.reject(new Error('Missing directory'))
      }
      const shallow = watchOptions.mode === 'shallow'
      const entry: NativeSubscription = { root, shallow, callback, hooks, live: true }
      subscribeLog.push(entry)
      if (!shallow) {
        nativeWatches.set(root, { callback, hooks })
      }
      return new Promise((resolve) => {
        queueMicrotask(() => {
          resolve({
            unsubscribe: async () => {
              entry.live = false
            }
          })
          if (root === failing) {
            queueMicrotask(() => hooks.onTerminalError?.(new Error('Failed to read changes')))
          }
        })
      })
    }
  )
  vi.useFakeTimers()
  housekeeping = new PluginServiceHousekeeping()
  options = {
    enabled: true,
    devPaths: [healthy, failing],
    reapIdle: () => {},
    refresh: () => housekeeping.sync(options)
  }
  housekeeping.sync(options)
  await vi.advanceTimersByTimeAsync(1_000)
})

afterEach(async () => {
  housekeeping.dispose()
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  await rm(fixture, { recursive: true, force: true })
})

function revision(root: string): string {
  return pluginFrameContentRevision({ rootDir: root, contentHash: null })
}

function registrations(root: string): number {
  return subscribeLog.filter((s) => s.root === root && !s.shallow).length
}

function native(root: string): NativeWatch {
  const watch = nativeWatches.get(root)
  if (!watch) {
    throw new Error('Missing native watcher fixture')
  }
  return watch
}

it('keeps healthy frame content current while terminal failures recover independently', async () => {
  const healthyRevision = revision(healthy)
  let failedRevision = revision(failing)
  for (let cycle = 0; cycle < 2; cycle += 1) {
    housekeeping.sync({ ...options, devPaths: [...options.devPaths] })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(revision(failing)).toBe(failedRevision)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(revision(failing)).not.toBe(failedRevision))
    failedRevision = revision(failing)
    expect(revision(healthy)).toBe(healthyRevision)
    expect(pluginDevChangeCount(healthy)).toBe(0)
  }
  native(healthy).callback(null, [{ type: 'update', path: join(healthy, 'asset.js') }])
  expect(revision(healthy)).not.toBe(healthyRevision)
  expect(pluginDevChangeCount(healthy)).toBe(1)

  const retiredWatch = native(failing)
  options = { ...options, devPaths: [healthy] }
  housekeeping.sync(options)
  retiredWatch.hooks.onInterruption?.()
  retiredWatch.callback(null, [{ type: 'update', path: join(failing, 'asset.js') }])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(revision(failing)).toBe(failedRevision)
})

it('catches up a replaced root without restarting another healthy frame', async () => {
  const other = join(fixture, 'other')
  await mkdir(other)
  options = { ...options, devPaths: [healthy, other] }
  housekeeping.sync(options)
  await vi.advanceTimersByTimeAsync(1_000)
  const healthyRevision = revision(healthy)
  const otherRevision = revision(other)
  await rename(healthy, join(fixture, 'retired'))
  await mkdir(healthy)
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(revision(healthy)).not.toBe(healthyRevision))
  expect(revision(other)).toBe(otherRevision)
  native(healthy).callback(null, [{ type: 'update', path: join(healthy, 'asset.js') }])
  expect(pluginDevChangeCount(healthy)).toBe(1)
})

it('catches up a missing root when it appears without changing another frame', async () => {
  const missing = join(fixture, 'missing')
  options = { ...options, devPaths: [healthy, missing] }
  housekeeping.sync(options)
  await vi.advanceTimersByTimeAsync(1_000)
  const healthyRevision = revision(healthy)
  const missingRevision = revision(missing)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(revision(missing)).toBe(missingRevision)
  await mkdir(missing)
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(revision(missing)).not.toBe(missingRevision))
  expect(revision(healthy)).toBe(healthyRevision)
  native(missing).callback(null, [{ type: 'update', path: join(missing, 'asset.js') }])
  expect(pluginDevChangeCount(missing)).toBe(1)
})

it('retries a root whose registration keeps rejecting once per maintenance tick', async () => {
  const unreachable = join(fixture, 'unreachable')
  await mkdir(unreachable)
  rejectingRoots.add(unreachable)
  const refresh = vi.fn(() => housekeeping.sync(options))
  options = { ...options, devPaths: [healthy, unreachable], refresh }
  housekeeping.sync(options)
  await vi.advanceTimersByTimeAsync(1_000)
  const healthyRevision = revision(healthy)
  refresh.mockClear()
  const attempts = vi
    .mocked(subscribeViaWatcherProcess)
    .mock.calls.filter(([root]) => root === unreachable)
  expect(attempts).toHaveLength(1)
  for (let tick = 2; tick <= 4; tick += 1) {
    await vi.advanceTimersByTimeAsync(60_000)
    // Why waitFor: the binding check reads the real filesystem.
    await vi.waitFor(() =>
      expect(
        vi.mocked(subscribeViaWatcherProcess).mock.calls.filter(([root]) => root === unreachable)
      ).toHaveLength(tick)
    )
    await vi.advanceTimersByTimeAsync(1_000)
  }
  expect(revision(healthy)).toBe(healthyRevision)
  expect(registrations(healthy)).toBe(1)
  // A retry that keeps failing does not rediscover every plugin each tick.
  expect(refresh).not.toHaveBeenCalled()
  // Once reachable, the next tick binds it and later edits reload it.
  rejectingRoots.delete(unreachable)
  const unreachableRevision = revision(unreachable)
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(revision(unreachable)).not.toBe(unreachableRevision))
  native(unreachable).callback(null, [{ type: 'update', path: join(unreachable, 'a.js') }])
  expect(pluginDevChangeCount(unreachable)).toBe(1)
  expect(revision(healthy)).toBe(healthyRevision)
})

it('keeps sibling roots independent on Linux, where each watches its parent', async () => {
  housekeeping.dispose()
  subscribeLog = []
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  const sibling = join(fixture, 'sibling')
  await mkdir(sibling)
  options = { ...options, devPaths: [healthy, sibling] }
  housekeeping = new PluginServiceHousekeeping()
  housekeeping.sync(options)
  await vi.advanceTimersByTimeAsync(1_000)
  const parent = subscribeLog.filter((s) => s.shallow && s.live)
  expect(parent).toHaveLength(2)
  const healthyRevision = revision(healthy)
  const siblingRevision = revision(sibling)

  // The sibling is deleted and recreated: its parent watch recovers it without a maintenance tick.
  await rm(sibling, { recursive: true })
  native(sibling).callback(null, [{ type: 'delete', path: sibling }])
  await vi.advanceTimersByTimeAsync(1_000)
  await mkdir(sibling)
  const siblingParent = subscribeLog.findLast((s) => s.shallow && s.live)
  siblingParent?.callback(null, [{ type: 'create', path: sibling }])
  await vi.advanceTimersByTimeAsync(1_000)
  expect(revision(sibling)).not.toBe(siblingRevision)
  expect(revision(healthy)).toBe(healthyRevision)
  expect(registrations(healthy)).toBe(1)
  expect(subscribeLog.filter((s) => s.shallow && s.live)).toHaveLength(2)
  native(healthy).callback(null, [{ type: 'update', path: join(healthy, 'panel.html') }])
  expect(revision(healthy)).not.toBe(healthyRevision)
})
