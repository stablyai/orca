import { dirname, join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import type * as Fs from 'node:fs'
import { mkdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  subscribeViaWatcherProcess,
  type WatcherProcessCallback,
  type WatcherProcessHooks,
  type WatcherProcessSubscribeOptions
} from '../ipc/parcel-watcher-process'
import {
  createAliasedWatcherRoot as createNativeAliasedWatcherRoot,
  removeAliasedWatcherRoot,
  type AliasedWatcherRoot
} from '../ipc/watcher-aliased-root-fixture'
import { PluginDevWatcher } from './plugin-dev-watcher'
import { PluginServiceHousekeeping } from './plugin-service-housekeeping'

vi.mock('../ipc/parcel-watcher-process', () => ({ subscribeViaWatcherProcess: vi.fn() }))
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

function pluginRootSubscription(): PluginWatchSubscription {
  const subscription = subscriptions.find((item) => item.options.mode !== 'shallow')
  if (!subscription) {
    throw new Error('Plugin root subscription missing')
  }
  return subscription
}

function pluginParentSubscription(): PluginWatchSubscription {
  const subscription = subscriptions.find((item) => item.options.mode === 'shallow')
  if (!subscription) {
    throw new Error('Plugin parent subscription missing')
  }
  return subscription
}

describe('PluginDevWatcher', () => {
  it('contains asynchronous watcher errors and requests a retrying refresh', async () => {
    vi.useFakeTimers()
    const { watcher, refresh, onWatcherError } = startDevWatcher()
    await Promise.resolve()
    const subscription = pluginRootSubscription()
    expect(() => subscription.callback(new Error('watch failed'), [])).not.toThrow()
    await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalledOnce())
    expect(onWatcherError).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(300)
    expect(refresh).toHaveBeenCalledOnce()
    watcher.dispose()
  })

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

  it('releases a subscription that resolves after reporting a setup failure', async () => {
    vi.useFakeTimers()
    subscribeMock.mockImplementation(async (path, callback, options, hooks = {}) => {
      const unsubscribe = vi.fn().mockResolvedValue(undefined)
      subscriptions.push({ path, callback, options, hooks, unsubscribe })
      if (options.mode !== 'shallow') {
        callback(new Error('setup failed'), [])
      }
      return { unsubscribe }
    })
    const { refresh, onWatcherError } = startDevWatcher()
    await vi.waitFor(() => expect(pluginRootSubscription().unsubscribe).toHaveBeenCalledOnce())
    expect(onWatcherError).toHaveBeenCalledOnce()
    pluginRootSubscription().hooks.onInterruption?.()
    vi.advanceTimersByTime(300)
    expect(refresh).toHaveBeenCalledOnce()
    expect(onWatcherError).toHaveBeenCalledOnce()
  })

  it('contains unsubscribe rejections so disposal cannot fail the host process', async () => {
    const { watcher } = startDevWatcher()
    await Promise.resolve()
    for (const subscription of subscriptions) {
      subscription.unsubscribe.mockRejectedValue(new Error('Root already deleted'))
    }
    expect(() => watcher.dispose()).not.toThrow()
    await vi.waitFor(() => {
      for (const subscription of subscriptions) {
        expect(subscription.unsubscribe).toHaveBeenCalledOnce()
      }
    })
  })

  it('keeps a missing root idle until its parent reports recreation', async () => {
    vi.useFakeTimers()
    const subscribeNormally = subscribeMock.getMockImplementation()
    if (!subscribeNormally) {
      throw new Error('Subscription mock missing')
    }
    subscribeMock.mockImplementation((path, callback, options, hooks) =>
      path === devPath
        ? Promise.reject(new Error('missing path'))
        : subscribeNormally(path, callback, options, hooks)
    )
    const { refresh, onWatcherError } = startDevWatcher()
    await vi.waitFor(() => expect(onWatcherError).toHaveBeenCalledOnce())
    vi.advanceTimersByTime(10_000)
    expect(refresh).not.toHaveBeenCalled()
    pluginParentSubscription().callback(null, [{ type: 'update', path: devPath }])
    vi.advanceTimersByTime(300)
    expect(onWatcherError).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('invalidates failed parent registration without starting a refresh loop', async () => {
    vi.useFakeTimers()
    subscribeMock.mockRejectedValue(new Error('parent unavailable'))
    const { refresh, onWatcherError } = startDevWatcher()
    await vi.waitFor(() => expect(onWatcherError).toHaveBeenCalledTimes(2))
    vi.advanceTimersByTime(10_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(subscribeMock).toHaveBeenCalledTimes(2)
  })

  it('releases a root deleted without an error and refreshes again when recreated', async () => {
    vi.useFakeTimers()
    const { refresh, onWatcherError } = startDevWatcher()
    await Promise.resolve()
    const root = pluginRootSubscription()
    root.callback(null, [{ type: 'delete', path: devPath }])
    expect(root.unsubscribe).toHaveBeenCalledOnce()
    expect(onWatcherError).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(300)
    expect(refresh).toHaveBeenCalledOnce()
    pluginParentSubscription().callback(null, [{ type: 'update', path: devPath }])
    vi.advanceTimersByTime(300)
    expect(refresh).toHaveBeenCalledTimes(2)
    root.callback(null, [{ type: 'create', path: resolve(devPath, 'stale.html') }])
    vi.advanceTimersByTime(300)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('refreshes the whole plugin projection after an overflow', () => {
    vi.useFakeTimers()
    const { refresh, onWatcherError } = startDevWatcher()
    const overflow = pluginRootSubscription().hooks.onOverflow
    expect(overflow).toBeTypeOf('function')
    overflow?.()
    vi.advanceTimersByTime(300)
    expect(onWatcherError).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('shares a shallow parent subscription between neighboring dev plugins', () => {
    const sibling = resolve('plugins', 'other')
    startDevWatcher(undefined, undefined, [devPath, sibling])
    expect(subscribeMock).toHaveBeenCalledTimes(3)
    expect(pluginParentSubscription().path).toBe(dirname(devPath))
    expect(pluginParentSubscription().options).toEqual({
      mode: 'shallow',
      include: ['demo', 'other']
    })
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a backslash in a POSIX plugin basename',
    () => {
      const backslashPath = resolve('plugins', 'demo\\name')
      startDevWatcher(undefined, undefined, [backslashPath])
      expect(pluginParentSubscription().options).toEqual({
        mode: 'shallow',
        include: ['demo\\name']
      })
    }
  )

  it('watches physical and aliased root names without duplicating their parent', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-alias-')
    startDevWatcher(undefined, undefined, [aliasedRoot.aliasRoot])
    expect(pluginRootSubscription().path).toBe(aliasedRoot.aliasRoot)
    expect(pluginParentSubscription().path).toBe(aliasedRoot.base)
    expect(pluginParentSubscription().options).toEqual({
      mode: 'shallow',
      include: ['alias', 'real']
    })
    expect(subscribeMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the physical root name while a configured alias is dangling', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-missing-alias-')
    const { watcher } = startDevWatcher(undefined, undefined, [aliasedRoot.aliasRoot])
    await rm(aliasedRoot.realRoot, { recursive: true })
    subscriptions = []
    watcher.start([aliasedRoot.aliasRoot], vi.fn())
    expect(pluginParentSubscription().options).toEqual({
      mode: 'shallow',
      include: ['alias', 'real']
    })
  })

  it('rewatches the new physical root when an ancestor alias is retargeted', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-ancestor-alias-')
    const nextRoot = join(aliasedRoot.base, 'next')
    await mkdir(join(aliasedRoot.realRoot, 'demo'))
    await mkdir(join(nextRoot, 'demo'), { recursive: true })
    const path = join(aliasedRoot.aliasRoot, 'demo')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const watcher = new PluginDevWatcher()
    devWatchers.push(watcher)
    const refresh = vi.fn(() => watcher.start([path], refresh, onWatcherError))
    const onWatcherError = vi.fn()
    watcher.start([path], refresh, onWatcherError)
    await Promise.resolve()
    const oldSubscriptions = [...subscriptions]
    expect(subscribeMock).toHaveBeenCalledOnce()
    expect(subscriptions.every((item) => item.options.mode !== 'shallow')).toBe(true)

    await rm(aliasedRoot.aliasRoot, { recursive: true })
    await symlink(
      nextRoot,
      aliasedRoot.aliasRoot,
      originalPlatform === 'win32' ? 'junction' : 'dir'
    )
    expect(await watcher.checkRootBindings()).toBe(true)
    refresh()

    expect(refresh).toHaveBeenCalledOnce()
    expect(onWatcherError).not.toHaveBeenCalled()
    expect(await watcher.checkRootBindings()).toBe(false)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    for (const subscription of oldSubscriptions) {
      expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    }
  })

  it('detects changes through chained aliases without adding broad parent guards', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-nested-alias-')
    const nestedRoot = join(aliasedRoot.base, 'nested')
    await mkdir(join(nestedRoot, 'demo'), { recursive: true })
    await mkdir(join(nestedRoot, 'other'))
    const intermediate = join(aliasedRoot.base, 'intermediate')
    const inner = join(aliasedRoot.realRoot, 'inner')
    const linkType = originalPlatform === 'win32' ? 'junction' : 'dir'
    await symlink(nestedRoot, intermediate, linkType)
    await symlink(intermediate, inner, linkType)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { watcher, refresh } = startDevWatcher(undefined, undefined, [
      join(aliasedRoot.aliasRoot, 'inner', 'demo'),
      join(aliasedRoot.aliasRoot, 'inner', 'other')
    ])

    expect(subscriptions.every((item) => item.options.mode !== 'shallow')).toBe(true)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(await watcher.checkRootBindings()).toBe(false)
    const nextRoot = join(aliasedRoot.base, 'next')
    await mkdir(join(nextRoot, 'demo'), { recursive: true })
    await mkdir(join(nextRoot, 'other'))
    await rm(intermediate, { recursive: true })
    await symlink(nextRoot, intermediate, linkType)
    expect(await watcher.checkRootBindings()).toBe(true)
    expect(await watcher.checkRootBindings()).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it.skipIf(originalPlatform !== 'darwin')(
    'detects alias retargeting with different casing',
    async () => {
      aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-case-alias-')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
      const configuredRoot = join(aliasedRoot.base, 'ALIAS')
      const { watcher } = startDevWatcher(undefined, undefined, [configuredRoot])
      expect(await watcher.checkRootBindings()).toBe(false)
      const nextRoot = join(aliasedRoot.base, 'next')
      await mkdir(nextRoot)
      await rm(aliasedRoot.aliasRoot, { recursive: true })
      await symlink(nextRoot, aliasedRoot.aliasRoot, 'dir')
      expect(await watcher.checkRootBindings()).toBe(true)
      expect(subscriptions.every((item) => item.options.mode !== 'shallow')).toBe(true)
    }
  )

  it('detects a replacement inode at the same canonical root', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-inode-')
    const { watcher } = startDevWatcher(undefined, undefined, [aliasedRoot.realRoot])
    expect(await watcher.checkRootBindings()).toBe(false)
    await rename(aliasedRoot.realRoot, join(aliasedRoot.base, 'old'))
    await mkdir(aliasedRoot.realRoot)
    expect(await watcher.checkRootBindings()).toBe(true)
    expect(await watcher.checkRootBindings()).toBe(false)
  })

  it.each(['dev', 'ino'] as const)(
    'detects adjacent 64-bit %s values without losing precision',
    async (field) => {
      aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-large-identity-')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
      const path = aliasedRoot.realRoot
      const previousId = 9_007_199_254_740_992n
      const nextId = previousId + 1n
      expect(Number(previousId)).toBe(Number(nextId))
      const previousIdentity = { dev: previousId, ino: previousId }
      const nextIdentity = { ...previousIdentity, [field]: nextId }
      const previousNumeric = Object.assign(statSync(path), {
        dev: Number(previousIdentity.dev),
        ino: Number(previousIdentity.ino)
      })
      const previousBigInt = Object.assign(statSync(path, { bigint: true }), previousIdentity)
      const nextNumeric = Object.assign(statSync(path), {
        dev: Number(nextIdentity.dev),
        ino: Number(nextIdentity.ino)
      })
      const nextBigInt = Object.assign(statSync(path, { bigint: true }), nextIdentity)
      vi.mocked(statSync).mockClear()
      vi.mocked(stat).mockClear()
      vi.mocked(statSync).mockImplementationOnce((_path, options) =>
        options?.bigint ? previousBigInt : previousNumeric
      )
      vi.mocked(stat)
        .mockImplementationOnce(async (_path, options) =>
          options?.bigint ? previousBigInt : previousNumeric
        )
        .mockImplementationOnce(async (_path, options) =>
          options?.bigint ? nextBigInt : nextNumeric
        )
        .mockImplementationOnce(async (_path, options) =>
          options?.bigint ? nextBigInt : nextNumeric
        )
      const { watcher } = startDevWatcher(undefined, undefined, [path])

      expect(await watcher.checkRootBindings()).toBe(false)
      expect(await watcher.checkRootBindings()).toBe(true)
      expect(await watcher.checkRootBindings()).toBe(false)
      expect(statSync).toHaveBeenCalledExactlyOnceWith(path, { bigint: true })
      expect(stat).toHaveBeenCalledTimes(3)
      for (const args of vi.mocked(stat).mock.calls) {
        expect(args).toEqual([path, { bigint: true }])
      }
    }
  )

  it('detects inode-less replacement using full-precision birth time', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-inode-less-')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const path = aliasedRoot.realRoot
    const birthtimeNs = 9_007_199_254_740_992n
    const initial = Object.assign(statSync(path, { bigint: true }), {
      dev: 1n,
      ino: 0n,
      birthtimeNs
    })
    const replacement = Object.assign(statSync(path, { bigint: true }), {
      dev: 1n,
      ino: 0n,
      birthtimeNs: birthtimeNs + 1n
    })
    vi.mocked(statSync).mockReturnValueOnce(initial)
    vi.mocked(stat)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(replacement)
    const { watcher } = startDevWatcher(undefined, undefined, [path])

    expect(await watcher.checkRootBindings()).toBe(false)
    expect(await watcher.checkRootBindings()).toBe(true)
    expect(await watcher.checkRootBindings()).toBe(false)
  })

  it('distinguishes an inode ID from the same birth time on an inode-less replacement', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-identity-domain-')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const path = aliasedRoot.realRoot
    const initial = Object.assign(statSync(path, { bigint: true }), {
      dev: 1n,
      ino: 77n,
      birthtimeNs: 1n
    })
    const replacement = Object.assign(statSync(path, { bigint: true }), {
      dev: 1n,
      ino: 0n,
      birthtimeNs: 77n
    })
    vi.mocked(statSync).mockReturnValueOnce(initial)
    vi.mocked(stat).mockResolvedValue(replacement)
    const { watcher } = startDevWatcher(undefined, undefined, [path])
    expect(await watcher.checkRootBindings()).toBe(true)
    expect(await watcher.checkRootBindings()).toBe(false)
  })

  it.each([0n, 77n])(
    'keeps timestamp edits from refreshing a healthy root with inode %s',
    async (ino) => {
      aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-edited-binding-')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
      const path = aliasedRoot.realRoot
      const initial = Object.assign(statSync(path, { bigint: true }), {
        dev: 1n,
        ino,
        birthtimeNs: 1n
      })
      const edited = Object.assign(statSync(path, { bigint: true }), {
        dev: 1n,
        ino,
        birthtimeNs: ino === 0n ? 1n : 2n,
        mtimeNs: initial.mtimeNs + 1n,
        ctimeNs: initial.ctimeNs + 1n
      })
      vi.mocked(statSync).mockReturnValueOnce(initial)
      vi.mocked(stat).mockResolvedValue(edited)
      vi.useFakeTimers()
      const lifecycle = new PluginServiceHousekeeping()
      housekeeping = lifecycle
      const checkBindings = vi.spyOn(PluginDevWatcher.prototype, 'checkRootBindings')
      const refresh = vi.fn(() => lifecycle.sync(options))
      const options = { enabled: true, devPaths: [path], refresh, reapIdle: vi.fn() }
      lifecycle.sync(options)
      await Promise.resolve()
      for (let tick = 0; tick < 3; tick += 1) {
        await vi.advanceTimersByTimeAsync(60_000)
        expect(checkBindings).toHaveBeenCalledTimes(tick + 1)
        await expect(checkBindings.mock.results[tick]?.value).resolves.toBe(false)
      }
      expect(refresh).not.toHaveBeenCalled()
      expect(subscribeMock).toHaveBeenCalledOnce()
      expect(pluginRootSubscription().unsubscribe).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
    }
  )

  it('keeps a missing root unavailable while a file occupies its path', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-file-binding-')
    const path = join(aliasedRoot.realRoot, 'demo')
    const { watcher } = startDevWatcher(undefined, undefined, [path])
    await writeFile(path, '')
    expect(await watcher.checkRootBindings()).toBe(false)
    await rm(path)
    await mkdir(path)
    expect(await watcher.checkRootBindings()).toBe(true)
  })

  it('detects missing and restored roots once per transition', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-missing-binding-')
    const missingRoot = join(aliasedRoot.realRoot, 'demo')
    const { watcher } = startDevWatcher(undefined, undefined, [missingRoot])
    expect(await watcher.checkRootBindings()).toBe(false)
    await mkdir(missingRoot)
    expect(await watcher.checkRootBindings()).toBe(true)
    expect(await watcher.checkRootBindings()).toBe(false)
    await rm(missingRoot, { recursive: true })
    expect(await watcher.checkRootBindings()).toBe(true)
    expect(await watcher.checkRootBindings()).toBe(false)
  })

  it('uses constant metadata checks without refreshing healthy roots', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-stable-binding-')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const { watcher, refresh } = startDevWatcher(undefined, undefined, [aliasedRoot.realRoot])
    vi.mocked(realpath).mockClear()
    vi.mocked(stat).mockClear()
    for (let tick = 0; tick < 3; tick += 1) {
      expect(await watcher.checkRootBindings()).toBe(false)
    }
    expect(realpath).toHaveBeenCalledTimes(3)
    expect(stat).toHaveBeenCalledTimes(3)
    expect(subscribeMock).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes Windows child creates and deletes without restarting the healthy root', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-windows-edits-')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers()
    const lifecycle = new PluginServiceHousekeeping()
    housekeeping = lifecycle
    const checkBindings = vi.spyOn(PluginDevWatcher.prototype, 'checkRootBindings')
    const path = aliasedRoot.realRoot
    const refresh = vi.fn(() => lifecycle.sync(options))
    const options = { enabled: true, devPaths: [path], refresh, reapIdle: vi.fn() }
    lifecycle.sync(options)
    await Promise.resolve()
    const root = pluginRootSubscription()

    for (const type of ['create', 'delete'] as const) {
      root.callback(null, [{ type, path: join(path, 'nested', 'manifest.json') }])
      // Windows also reports the child directory name to its parent's fs.watch.
      for (const parent of subscriptions.filter((item) => item.options.mode === 'shallow')) {
        parent.callback(null, [{ type: 'update', path }])
      }
      await vi.advanceTimersByTimeAsync(300)
    }

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(root.options).toEqual({ backend: 'windows' })
    expect(root.unsubscribe).not.toHaveBeenCalled()
    expect(subscribeMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(checkBindings).toHaveBeenCalledOnce()
    await expect(checkBindings.mock.results[0]?.value).resolves.toBe(false)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(subscribeMock).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('recovers a silent Windows root replacement on the existing maintenance tick', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-windows-replacement-')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers()
    const lifecycle = new PluginServiceHousekeeping()
    housekeeping = lifecycle
    const path = aliasedRoot.realRoot
    const refresh = vi.fn(() => lifecycle.sync(options))
    const options = { enabled: true, devPaths: [path], refresh, reapIdle: vi.fn() }
    lifecycle.sync(options)
    await Promise.resolve()
    const root = pluginRootSubscription()
    await rename(path, join(aliasedRoot.base, 'old'))
    await mkdir(path)

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(root.unsubscribe).toHaveBeenCalledOnce()
    expect(subscriptions.map((item) => ({ path: item.path, options: item.options }))).toEqual([
      { path, options: { backend: 'windows' } },
      { path, options: { backend: 'windows' } }
    ])
    subscriptions.at(-1)?.callback(null, [{ type: 'create', path: join(path, 'manifest.json') }])
    await vi.advanceTimersByTimeAsync(300)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    lifecycle.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries setup failures only for roots that are present', async () => {
    aliasedRoot = await createAliasedWatcherRoot('orca-plugin-dev-retry-availability-')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    subscribeMock.mockRejectedValue(new Error('native setup failed'))
    const existing = startDevWatcher(undefined, undefined, [aliasedRoot.realRoot])
    await vi.waitFor(() => expect(existing.onWatcherError).toHaveBeenCalledExactlyOnceWith(true))
    const missing = startDevWatcher(undefined, undefined, [join(aliasedRoot.realRoot, 'missing')])
    await vi.waitFor(() => expect(missing.onWatcherError).toHaveBeenCalledExactlyOnceWith(false))
    expect(await missing.watcher.checkRootBindings()).toBe(false)
    expect(missing.refresh).not.toHaveBeenCalled()
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

  it('releases previous subscriptions before starting a new generation', async () => {
    const { watcher } = startDevWatcher()
    await Promise.resolve()
    const oldSubscriptions = [...subscriptions]
    watcher.start([resolve('plugins', 'replacement')], vi.fn())
    for (const subscription of oldSubscriptions) {
      expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    }
  })

  it('fences events, errors, interruptions and overflows after disposal', async () => {
    vi.useFakeTimers()
    const { watcher, refresh, onWatcherError } = startDevWatcher()
    await Promise.resolve()
    watcher.dispose()
    for (const subscription of subscriptions) {
      subscription.callback(null, [{ type: 'update', path: subscription.path }])
      subscription.callback(new Error('late failure'), [])
      subscription.hooks.onInterruption?.()
      subscription.hooks.onOverflow?.()
      subscription.hooks.onTerminalError?.(new Error('late terminal failure'))
    }
    vi.advanceTimersByTime(1_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(onWatcherError).not.toHaveBeenCalled()
  })
})
