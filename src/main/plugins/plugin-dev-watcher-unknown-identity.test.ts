import { statSync } from 'node:fs'
import type * as Fs from 'node:fs'
import { mkdir, rename, rm, stat, symlink } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  subscribeViaWatcherProcess,
  type WatcherProcessCallback
} from '../ipc/parcel-watcher-process'
import {
  createAliasedWatcherRoot,
  removeAliasedWatcherRoot,
  type AliasedWatcherRoot
} from '../ipc/watcher-aliased-root-fixture'
import { watcherDirectoryIdentity } from '../ipc/watcher-directory-identity'
import { PluginDevWatcher } from './plugin-dev-watcher'
import { PluginServiceHousekeeping } from './plugin-service-housekeeping'

vi.mock('../ipc/parcel-watcher-process', () => ({ subscribeViaWatcherProcess: vi.fn() }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs')
  return { ...actual, statSync: vi.fn(actual.statSync) }
})
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return { ...actual, stat: vi.fn(actual.stat) }
})

const originalPlatform = process.platform
const subscribeMock = vi.mocked(subscribeViaWatcherProcess)
let fixture: AliasedWatcherRoot
let watchers: PluginDevWatcher[] = []
let lifecycle: PluginServiceHousekeeping | null = null
let subscriptions: { callback: WatcherProcessCallback; unsubscribe: ReturnType<typeof vi.fn> }[] =
  []

beforeEach(async () => {
  vi.mocked(statSync).mockReset()
  vi.mocked(stat).mockReset()
  fixture = await createAliasedWatcherRoot('orca-plugin-unknown-identity-')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  subscribeMock.mockReset()
  subscribeMock.mockImplementation(async (_path, callback) => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    subscriptions.push({ callback, unsubscribe })
    return { unsubscribe }
  })
})

afterEach(async () => {
  lifecycle?.dispose()
  lifecycle = null
  for (const watcher of watchers) {
    watcher.dispose()
  }
  watchers = []
  subscriptions = []
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  await removeAliasedWatcherRoot(fixture)
})

function inodeLessEntry(birthtimeNs: bigint, ctimeNs: bigint) {
  return Object.assign(statSync(fixture.realRoot, { bigint: true }), {
    dev: 1n,
    ino: 0n,
    birthtimeNs,
    ctimeNs,
    mtimeNs: ctimeNs
  })
}

function start(path = fixture.realRoot) {
  const watcher = new PluginDevWatcher()
  watchers.push(watcher)
  const refresh = vi.fn()
  const error = vi.fn()
  watcher.start([path], refresh, error)
  return { watcher, refresh, error }
}

it.each(['zero', 'ctime'] as const)(
  'keeps unavailable %s birth time quiet while native content edits still refresh',
  async (kind) => {
    const initial = inodeLessEntry(kind === 'zero' ? 0n : 1n, 1n)
    const edited = inodeLessEntry(kind === 'zero' ? 0n : 2n, 2n)
    expect(watcherDirectoryIdentity(initial)).toBeNull()
    vi.mocked(statSync).mockReturnValueOnce(initial)
    vi.mocked(stat).mockResolvedValue(edited)
    vi.useFakeTimers()
    const housekeeping = new PluginServiceHousekeeping()
    lifecycle = housekeeping
    const checks = vi.spyOn(PluginDevWatcher.prototype, 'checkRootBindings')
    const refresh = vi.fn(() => housekeeping.sync(options))
    const options = { enabled: true, devPaths: [fixture.realRoot], refresh, reapIdle: vi.fn() }
    housekeeping.sync(options)
    await Promise.resolve()
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      await expect(checks.mock.results[tick]?.value).resolves.toBe(false)
    }
    expect(refresh).not.toHaveBeenCalled()
    subscriptions[0]?.callback(null, [
      { type: 'create', path: join(fixture.realRoot, 'manifest.json') }
    ])
    await vi.advanceTimersByTimeAsync(300)
    expect(refresh).toHaveBeenCalledOnce()
    expect(subscribeMock).toHaveBeenCalledOnce()
    expect(subscriptions[0]?.unsubscribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
  }
)

it.each(['zero', 'ctime'] as const)(
  'retries genuine setup failures for a present root with unavailable %s birth time',
  async (kind) => {
    const initial = inodeLessEntry(kind === 'zero' ? 0n : 1n, 1n)
    vi.mocked(statSync).mockReturnValueOnce(initial)
    subscribeMock.mockRejectedValue(new Error('native registration failed'))
    const { error } = start()
    await vi.waitFor(() => expect(error).toHaveBeenCalledExactlyOnceWith(true))
  }
)

it('detects disappearance and recreation even when identity is unknown', async () => {
  const initial = inodeLessEntry(0n, 1n)
  vi.mocked(statSync).mockReturnValueOnce(initial)
  vi.mocked(stat).mockResolvedValueOnce(initial)
  const { watcher } = start()
  expect(await watcher.checkRootBindings()).toBe(false)
  await rm(fixture.realRoot, { recursive: true })
  expect(await watcher.checkRootBindings()).toBe(true)
  expect(await watcher.checkRootBindings()).toBe(false)
  await mkdir(fixture.realRoot)
  vi.mocked(stat).mockResolvedValueOnce(initial)
  expect(await watcher.checkRootBindings()).toBe(true)
  vi.mocked(stat).mockResolvedValueOnce(initial)
  expect(await watcher.checkRootBindings()).toBe(false)
})

it('detects alias retargeting between roots with unknown identity', async () => {
  const initial = inodeLessEntry(0n, 1n)
  vi.mocked(statSync).mockReturnValueOnce(initial)
  vi.mocked(stat).mockResolvedValue(initial)
  const { watcher } = start(fixture.aliasRoot)
  const next = join(fixture.base, 'next')
  await mkdir(next)
  await rm(fixture.aliasRoot, { recursive: true })
  await symlink(next, fixture.aliasRoot, originalPlatform === 'win32' ? 'junction' : 'dir')
  expect(await watcher.checkRootBindings()).toBe(true)
  expect(await watcher.checkRootBindings()).toBe(false)
})

it('admits one rebind when identity becomes usable while loss of identity stays quiet', async () => {
  const newborn = inodeLessEntry(1n, 1n)
  const usable = inodeLessEntry(1n, 2n)
  const unknown = inodeLessEntry(0n, 3n)
  const replacement = inodeLessEntry(2n, 3n)
  vi.mocked(statSync).mockReturnValueOnce(newborn)
  vi.mocked(stat)
    .mockResolvedValueOnce(usable)
    .mockResolvedValueOnce(usable)
    .mockResolvedValueOnce(unknown)
    .mockResolvedValueOnce(usable)
    .mockResolvedValueOnce(usable)
    .mockResolvedValueOnce(unknown)
    .mockResolvedValueOnce(replacement)
    .mockResolvedValueOnce(replacement)
  const { watcher, refresh } = start()
  expect(await watcher.checkRootBindings()).toBe(true)
  expect(await watcher.checkRootBindings()).toBe(false)
  expect(await watcher.checkRootBindings()).toBe(false)
  expect(await watcher.checkRootBindings()).toBe(false)
  expect(await watcher.checkRootBindings()).toBe(false)
  expect(await watcher.checkRootBindings()).toBe(false)
  expect(await watcher.checkRootBindings()).toBe(true)
  expect(await watcher.checkRootBindings()).toBe(false)
  expect(refresh).not.toHaveBeenCalled()
  expect(subscribeMock).toHaveBeenCalledOnce()
})

it('recovers a silent replacement when previously unknown identity first becomes usable', async () => {
  const initial = inodeLessEntry(1n, 1n)
  const usable = inodeLessEntry(1n, 2n)
  vi.mocked(statSync).mockReturnValueOnce(initial).mockReturnValueOnce(usable)
  vi.mocked(stat).mockResolvedValue(usable)
  vi.useFakeTimers()
  const housekeeping = new PluginServiceHousekeeping()
  lifecycle = housekeeping
  const checks = vi.spyOn(PluginDevWatcher.prototype, 'checkRootBindings')
  const refresh = vi.fn(() => housekeeping.sync(options))
  const options = { enabled: true, devPaths: [fixture.realRoot], refresh, reapIdle: vi.fn() }
  housekeeping.sync(options)
  await Promise.resolve()
  await rename(fixture.realRoot, join(fixture.base, 'old'))
  await mkdir(fixture.realRoot)
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(subscribeMock).toHaveBeenCalledTimes(2)
  expect(subscriptions[0]?.unsubscribe).toHaveBeenCalledOnce()
  for (let tick = 1; tick < 4; tick += 1) {
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(checks.mock.results[tick]?.value).resolves.toBe(false)
  }
  expect(refresh).toHaveBeenCalledOnce()
  expect(subscribeMock).toHaveBeenCalledTimes(2)
})

it('retries a failed native setup for an unknown present root on the existing maintenance tick', async () => {
  const initial = inodeLessEntry(0n, 1n)
  vi.mocked(statSync).mockReturnValue(initial)
  vi.mocked(stat).mockResolvedValue(initial)
  subscribeMock.mockRejectedValueOnce(new Error('native registration failed'))
  vi.useFakeTimers()
  const housekeeping = new PluginServiceHousekeeping()
  lifecycle = housekeeping
  const refresh = vi.fn(() => housekeeping.sync(options))
  const options = { enabled: true, devPaths: [fixture.realRoot], refresh, reapIdle: vi.fn() }
  housekeeping.sync(options)
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(subscribeMock).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(180_000)
  expect(refresh).toHaveBeenCalledOnce()
  expect(subscribeMock).toHaveBeenCalledTimes(2)
})

it('uses native notifications to recover when a silent replacement has no usable metadata identity', async () => {
  const initial = inodeLessEntry(0n, 1n)
  vi.mocked(statSync).mockReturnValue(initial)
  vi.mocked(stat).mockResolvedValue(initial)
  vi.useFakeTimers()
  const housekeeping = new PluginServiceHousekeeping()
  lifecycle = housekeeping
  const checks = vi.spyOn(PluginDevWatcher.prototype, 'checkRootBindings')
  const refresh = vi.fn(() => housekeeping.sync(options))
  const options = { enabled: true, devPaths: [fixture.realRoot], refresh, reapIdle: vi.fn() }
  housekeeping.sync(options)
  await Promise.resolve()
  await rename(fixture.realRoot, join(fixture.base, 'old'))
  await mkdir(fixture.realRoot)
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(checks.mock.results[0]?.value).resolves.toBe(false)
  expect(refresh).not.toHaveBeenCalled()
  const old = subscriptions[0]
  old?.callback(null, [{ type: 'delete', path: fixture.realRoot }])
  await vi.advanceTimersByTimeAsync(300)
  expect(refresh).toHaveBeenCalledOnce()
  expect(old?.unsubscribe).toHaveBeenCalledOnce()
  expect(subscribeMock).toHaveBeenCalledTimes(2)
  subscriptions[1]?.callback(null, [
    { type: 'create', path: join(fixture.realRoot, 'manifest.json') }
  ])
  await vi.advanceTimersByTimeAsync(300)
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(subscribeMock).toHaveBeenCalledTimes(2)
})
