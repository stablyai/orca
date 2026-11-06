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
import { PluginDevWatcher } from './plugin-dev-watcher'
import { PluginServiceHousekeeping } from './plugin-service-housekeeping'

vi.mock('../ipc/filesystem/watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))

type NativeWatch = { callback: WatcherProcessCallback; hooks: WatcherProcessHooks }
const nativeWatches = new Map<string, NativeWatch>()
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
  vi.mocked(subscribeViaWatcherProcess).mockImplementation(
    (root, callback, _options, hooks = {}) => {
      if (!existsSync(root)) {
        return Promise.reject(new Error('Missing directory'))
      }
      nativeWatches.set(root, { callback, hooks })
      return new Promise((resolve) => {
        queueMicrotask(() => {
          resolve({ unsubscribe: async () => {} })
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

it.each(['onInterruption', 'onOverflow'] as const)(
  'catches up the affected frame promptly after %s without retrying terminal failures',
  async (event) => {
    const healthyRevision = revision(healthy)
    const failedRevision = revision(failing)
    native(healthy).hooks[event]?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(revision(healthy)).not.toBe(healthyRevision)
    expect(revision(failing)).toBe(failedRevision)
    native(healthy).callback(null, [{ type: 'update', path: join(healthy, 'asset.js') }])
    expect(pluginDevChangeCount(healthy)).toBe(1)
  }
)

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

it('ignores binding checks that finish after disposal and leaves no timers', async () => {
  const pending = Promise.withResolvers<boolean | null>()
  const check = vi.spyOn(PluginDevWatcher.prototype, 'checkRootBindings')
  check.mockReturnValue(pending.promise)
  const refresh = vi.fn()
  housekeeping.sync({ ...options, refresh })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(check).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(60_000)
  // Why: a slow check per root coalesces instead of stacking a second one.
  expect(check).toHaveBeenCalledTimes(2)
  const failedRevision = revision(failing)
  housekeeping.dispose()
  pending.resolve(true)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(refresh).not.toHaveBeenCalled()
  expect(revision(failing)).toBe(failedRevision)
  expect(vi.getTimerCount()).toBe(0)
  check.mockRestore()
})
