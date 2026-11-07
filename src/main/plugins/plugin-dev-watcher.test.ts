import { resolve } from 'node:path'
import { statSync } from 'node:fs'
import type * as Fs from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeViaWatcherProcess } from '../ipc/filesystem/watcher-process/parcel-watcher-process'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from '../ipc/filesystem/watcher-process/parcel-watcher-process-subscription'
import type { WatcherProcessSubscribeOptions } from '../ipc/filesystem/watcher-process/parcel-watcher-process-protocol'
import {
  createAliasedWatcherRoot as createNativeAliasedWatcherRoot,
  removeAliasedWatcherRoot,
  type AliasedWatcherRoot
} from '../ipc/filesystem/watcher-process/watcher-aliased-root-fixture'
import { PluginDevWatcher } from './plugin-dev-watcher'
import type { PluginServiceHousekeeping } from './plugin-service-housekeeping'

vi.mock('../ipc/filesystem/watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs')
  return { ...actual, statSync: vi.fn(actual.statSync) }
})
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return { ...actual, realpath: vi.fn(actual.realpath), stat: vi.fn(actual.stat) }
})

type PluginWatchSubscription = {
  path: string
  callback: WatcherProcessCallback
  options: WatcherProcessSubscribeOptions
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}

const devPath = resolve('plugins', 'demo')

const originalPlatform = process.platform
const subscribeMock = vi.mocked(subscribeViaWatcherProcess)
let subscriptions: PluginWatchSubscription[] = []
let devWatchers: PluginDevWatcher[] = []
let housekeeping: PluginServiceHousekeeping | null = null
let aliasedRoot: AliasedWatcherRoot | null = null

beforeEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'linux'
  })
  subscribeMock.mockReset()
  vi.mocked(statSync).mockReset()
  vi.mocked(stat).mockReset()
  subscribeMock.mockImplementation(async (path, callback, options, hooks = {}) => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    subscriptions.push({ path, callback, options, hooks, unsubscribe })
    return { unsubscribe }
  })
})

afterEach(async () => {
  housekeeping?.dispose()
  housekeeping = null
  for (const watcher of devWatchers) {
    watcher.dispose()
  }
  devWatchers = []
  subscriptions = []
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  await removeAliasedWatcherRoot(aliasedRoot)
  aliasedRoot = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function createAliasedWatcherRoot(prefix: string): Promise<AliasedWatcherRoot> {
  const watcherPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  try {
    return await createNativeAliasedWatcherRoot(prefix)
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: watcherPlatform })
  }
}

function startDevWatcher(
  refresh = vi.fn(),
  onWatcherError = vi.fn(),
  paths = [devPath]
): {
  watcher: PluginDevWatcher
  refresh: ReturnType<typeof vi.fn>
  onWatcherError: ReturnType<typeof vi.fn>
} {
  const watcher = new PluginDevWatcher()
  devWatchers.push(watcher)
  watcher.start(paths, refresh, onWatcherError)
  return { watcher, refresh, onWatcherError }
}

describe('PluginDevWatcher', () => {
  it('unsubscribes every subscription that resolves after disposal', async () => {
    const pending: (() => void)[] = []
    subscribeMock.mockImplementation((path, callback, options, hooks = {}) => {
      const unsubscribe = vi.fn().mockResolvedValue(undefined)
      subscriptions.push({ path, callback, options, hooks, unsubscribe })
      return new Promise((settle) => pending.push(() => settle({ unsubscribe })))
    })
    const { watcher } = startDevWatcher()
    watcher.dispose()
    for (const settle of pending) {
      settle()
    }
    await vi.waitFor(() => {
      for (const subscription of subscriptions) {
        expect(subscription.unsubscribe).toHaveBeenCalledOnce()
      }
    })
  })

  it('fences a pending binding check after disposal or restart', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-late-binding-')
    const { watcher } = startDevWatcher(undefined, undefined, [aliasedRoot.realRoot])
    const { promise, resolve: resolveBinding } = Promise.withResolvers<string>()
    vi.mocked(realpath).mockReturnValueOnce(promise)
    const check = watcher.checkRootBindings()
    watcher.start([devPath], vi.fn())
    resolveBinding(aliasedRoot.realRoot)
    expect(await check).toBe(null)
    watcher.dispose()
    expect(await watcher.checkRootBindings()).toBe(false)
  })
})
