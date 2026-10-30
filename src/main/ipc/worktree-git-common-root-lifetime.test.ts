import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeViaWatcherProcess } from './filesystem/watcher-process/parcel-watcher-process'
import { WatcherProcessFailure } from './filesystem/watcher-process/parcel-watcher-process-failure'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from './filesystem/watcher-process/parcel-watcher-process-subscription'
import { startGitCommonNarrowWatch } from './worktree-git-common-narrow-watch'
import { startGitCommonPolling } from './worktree-git-common-polling'
import { handleLocalWatchEvents, type ActiveWatch } from './worktree-base-directory-watch-events'
import {
  createWorktreeHeadIdentityRefreshState,
  refreshWorktreeHeadIdentities
} from './worktree-head-identity-refresh'
import * as headReader from './worktree-head-identity-reader'
import { EMPTY_HEAD_IDENTITY_SCOPE } from './worktree-head-identity-scope'
import type { WorktreeBaseRepoWatchConfig } from './worktree-base-directory-event-filter'
import { WorktreeWatcherFailureRefreshCooldown } from './worktree-watcher-failure-refresh-cooldown'
import { notifyWatchedWorktreeCatalogChanged } from './watched-worktree-catalog-notification'
import {
  notifyWorktreeHeadIdentitiesChanged,
  notifyWorktreeGitStatusMetadataChanged
} from './worktree-remote'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription
} from './worktree-base-directory-poller'

type RootFilesystemControl = {
  root: string
  stat: (() => Promise<void>) | null
  read: (() => Promise<void>) | null
  reads: number
  files: string[]
  upgrade: () => Promise<void>
}
const fsControl = vi.hoisted<RootFilesystemControl>(() => ({
  root: '',
  stat: null,
  read: null,
  reads: 0,
  files: [],
  upgrade: async () => {}
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (typeof args[0] === 'string') {
        fsControl.files.push(args[0])
      }
      return actual.readFile(...args)
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (args[0] === fsControl.root) {
        await fsControl.stat?.()
      }
      return actual.stat(...args)
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === fsControl.root) {
        fsControl.reads++
        await fsControl.read?.()
      }
      return actual.readdir(...args)
    }
  }
})
vi.mock('./worktree-remote', () => ({
  notifyWorktreeGitStatusMetadataChanged: vi.fn(),
  notifyWorktreeHeadIdentitiesChanged: vi.fn()
}))
vi.mock('./watched-worktree-catalog-notification', () => ({
  notifyWatchedWorktreeCatalogChanged: vi.fn()
}))
vi.mock('./filesystem/watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))
// Drive the production upgrade directly without advancing five minutes of fallback polling.
vi.mock('./worktree-git-common-native-upgrade-poll', () => ({
  createNativeUpgradePoll: (attempt: () => Promise<void>) => {
    fsControl.upgrade = attempt
    return { arm: () => {}, stop: () => {} }
  }
}))

const POLL_MS = 10
const RECONCILE_MS = POLL_MS * 15
const visible = { isWindowVisible: () => true, onWindowBecameVisible: () => () => {} }
const native = vi.mocked(subscribeViaWatcherProcess)
const subscriptions: {
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}[] = []
const cleanups: (() => Promise<void>)[] = []
let common: string
const installNative: typeof subscribeViaWatcherProcess = async (
  _path,
  callback,
  _options,
  hooks = {}
) => {
  const unsubscribe = vi.fn(async () => {})
  subscriptions.push({ callback, hooks, unsubscribe })
  return { unsubscribe }
}

beforeEach(async () => {
  common = await realpath(await mkdtemp(join(tmpdir(), 'orca-root-lifetime-')))
  fsControl.root = join(common, 'worktrees')
  fsControl.stat = null
  fsControl.read = null
  fsControl.reads = 0
  fsControl.files = []
  vi.clearAllMocks()
  await recreate()
  native.mockReset()
  native.mockImplementation(installNative)
  vi.useFakeTimers()
})

afterEach(async () => {
  fsControl.stat = null
  fsControl.read = null
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await rm(common, { recursive: true, force: true })
  subscriptions.length = 0
  vi.useRealTimers()
})

async function recreate(): Promise<void> {
  await mkdir(join(fsControl.root, 'same-child'), { recursive: true })
}

function start(events: WorktreeBasePollEvent[][], errors = vi.fn(), overflow = vi.fn()) {
  return startGitCommonNarrowWatch(
    { key: 'root-lifetime', kind: 'git-common', path: common, repos: new Map() },
    (batch) => events.push(batch),
    POLL_MS,
    'darwin',
    visible,
    undefined,
    errors,
    overflow
  )
}

function lateDelivery(index: number): void {
  const old = subscriptions[index]
  old.callback(null, [{ type: 'update', path: join(fsControl.root, 'stale') }])
  old.hooks.onInterruption?.()
  old.hooks.onOverflow?.()
}

it('fences a pending native subscribe when root deletion and creation are separate snapshots', async () => {
  const pending = Promise.withResolvers<WorktreeBaseSubscription>()
  native.mockImplementation(async (...args) => {
    const subscription = await installNative(...args)
    return subscriptions.length === 2 ? pending.promise : subscription
  })
  const events: WorktreeBasePollEvent[][] = []
  const errors = vi.fn()
  const overflow = vi.fn()
  const watch = await start(events, errors, overflow)
  cleanups.push(() => watch.unsubscribe())
  try {
    subscriptions[0].callback(null, [{ type: 'delete', path: fsControl.root }])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
    events.length = 0
    fsControl.stat = async () => {
      fsControl.stat = null
      await rm(fsControl.root, { recursive: true })
    }
    fsControl.read = async () => {
      fsControl.read = null
      await recreate()
    }
    await vi.advanceTimersByTimeAsync(RECONCILE_MS)
    await vi.waitFor(() =>
      expect(events.flat()).toContainEqual({ type: 'delete', path: fsControl.root })
    )
    expect(events.flat()).not.toContainEqual({ type: 'create', path: fsControl.root })
    const before = events.length
    lateDelivery(1)
    expect(events).toHaveLength(before)
    expect(errors).not.toHaveBeenCalled()
    expect(overflow).not.toHaveBeenCalled()
    pending.resolve({ unsubscribe: subscriptions[1].unsubscribe })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(3))
    expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(RECONCILE_MS)
    await vi.waitFor(() =>
      expect(events.flat()).toContainEqual({ type: 'create', path: fsControl.root })
    )
    subscriptions[2].callback(null, [{ type: 'update', path: join(fsControl.root, 'fresh') }])
    expect(events.flat()).toContainEqual({ type: 'update', path: join(fsControl.root, 'fresh') })
  } finally {
    pending.resolve({ unsubscribe: subscriptions[1].unsubscribe })
  }
})

it.each([
  ['startup', 'ENOENT'],
  ['upgrade', 'ENOENT'],
  ['startup', 'ENOTDIR'],
  ['upgrade', 'ENOTDIR'],
  ['startup', 'EIO'],
  ['upgrade', 'EIO']
] as const)('handles %s baseline root observation %s before recreation', async (entry, code) => {
  const absent = code === 'ENOENT' || code === 'ENOTDIR'
  const blocked = Promise.withResolvers<void>()
  const reachedRead = vi.fn()
  native.mockImplementation(async (...args) => {
    if (entry === 'upgrade' && native.mock.calls.length === 1) {
      throw new WatcherProcessFailure('test fuse', 'supervisor', 'supervisor_crash_fuse')
    }
    const subscription = await installNative(...args)
    if (subscriptions.length === 1) {
      if (absent) {
        await rm(fsControl.root, { recursive: true })
      }
      fsControl.stat = async () => {
        fsControl.stat = null
        throw Object.assign(new Error('controlled root stat'), { code })
      }
      fsControl.read = async () => {
        reachedRead()
        await blocked.promise
      }
    }
    return subscription
  })
  const events: WorktreeBasePollEvent[][] = []
  const errors = vi.fn()
  const overflow = vi.fn()
  const starting = start(events, errors, overflow)
  let upgrading: Promise<void> | undefined
  try {
    if (entry === 'upgrade') {
      await starting
      upgrading = fsControl.upgrade()
    }
    await vi.waitFor(() => expect(reachedRead).toHaveBeenCalled())
    expect(events).toEqual(absent ? [[{ type: 'delete', path: fsControl.root }]] : [])
    const before = events.length
    lateDelivery(0)
    if (absent) {
      expect(events).toHaveLength(before)
      expect(errors).not.toHaveBeenCalled()
      expect(overflow).not.toHaveBeenCalled()
      expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    } else {
      expect(subscriptions[0].unsubscribe).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalledOnce()
      expect(overflow).toHaveBeenCalledOnce()
      expect(events).toHaveLength(before + 1)
    }
    await recreate()
    blocked.resolve()
    fsControl.read = null
    await starting
    await upgrading
    await vi.advanceTimersByTimeAsync(POLL_MS)
    if (absent) {
      await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
    }
    const current = subscriptions[absent ? 1 : 0]
    current.callback(null, [{ type: 'update', path: join(fsControl.root, 'fresh') }])
    expect(events.flat()).toContainEqual({ type: 'update', path: join(fsControl.root, 'fresh') })
    if (absent) {
      expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    }
  } finally {
    await recreate()
    blocked.resolve()
    fsControl.read = null
    await upgrading
    await (await starting).unsubscribe()
  }
})

it('converges when a delayed deletion snapshot retires an already fresh subscription', async () => {
  const events: WorktreeBasePollEvent[][] = []
  const errors = vi.fn()
  const overflow = vi.fn()
  const watch = await start(events, errors, overflow)
  cleanups.push(() => watch.unsubscribe())
  const blocked = Promise.withResolvers<void>()
  const reachedRead = vi.fn()
  fsControl.stat = async () => {
    fsControl.stat = null
    await rm(fsControl.root, { recursive: true })
  }
  fsControl.read = async () => {
    reachedRead()
    await blocked.promise
  }
  try {
    await vi.advanceTimersByTimeAsync(RECONCILE_MS)
    await vi.waitFor(() => expect(reachedRead).toHaveBeenCalled())
    subscriptions[0].callback(null, [{ type: 'delete', path: fsControl.root }])
    await recreate()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
    blocked.resolve()
    fsControl.read = null
    await vi.waitFor(() => expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce())
    const before = events.length
    lateDelivery(1)
    expect(events).toHaveLength(before)
    expect(errors).not.toHaveBeenCalled()
    expect(overflow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(3))
    const reads = fsControl.reads
    await vi.advanceTimersByTimeAsync(RECONCILE_MS * 3)
    await vi.waitFor(() => expect(fsControl.reads).toBeGreaterThan(reads))
    expect(subscriptions).toHaveLength(3)
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce()
    subscriptions[2].callback(null, [{ type: 'update', path: join(fsControl.root, 'fresh') }])
    expect(events.flat()).toContainEqual({ type: 'update', path: join(fsControl.root, 'fresh') })
  } finally {
    blocked.resolve()
  }
})

it.each(['EACCES', 'EIO', undefined, 'ENOENT', 'ENOTDIR'])(
  'preserves root evidence on stat error %s',
  async (code) => {
    const events: WorktreeBasePollEvent[][] = []
    const scanned = vi.fn()
    const watch = await startGitCommonPolling(
      common,
      (batch) => events.push(batch),
      POLL_MS,
      visible,
      scanned,
      false,
      () => [],
      { reconciliationFullScanEveryTicks: 1 }
    )
    cleanups.push(() => watch.unsubscribe())
    const absent = code === 'ENOENT' || code === 'ENOTDIR'
    fsControl.stat = async () => {
      throw Object.assign(new Error('controlled root stat'), { code })
    }
    const reads = fsControl.reads
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(fsControl.reads).toBeGreaterThan(reads))
    await vi.waitFor(() => expect(scanned).toHaveBeenCalled())
    expect(
      events.flat().some((event) => event.type === 'delete' && event.path === fsControl.root)
    ).toBe(absent)
    fsControl.stat = null
    const afterError = join(fsControl.root, 'after-error')
    await mkdir(afterError)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() =>
      expect(events.flat()).toContainEqual({ type: 'create', path: afterError })
    )
  }
)

it.each(['unknown baseline', 'reattachment'] as const)(
  'fences confirmed absence after %s leaves a missing root snapshot',
  async (schedule) => {
    native.mockImplementation(async (...args) => {
      const subscription = await installNative(...args)
      if (subscriptions.length === 1) {
        fsControl.stat = async () => {
          fsControl.stat = null
          if (schedule === 'unknown baseline') {
            throw Object.assign(new Error('controlled baseline root stat'), { code: 'EIO' })
          }
          await rm(fsControl.root, { recursive: true })
        }
        if (schedule === 'reattachment') {
          fsControl.read = async () => {
            fsControl.read = null
            await recreate()
          }
        }
      }
      return subscription
    })
    const events: WorktreeBasePollEvent[][] = []
    const errors = vi.fn()
    const overflow = vi.fn()
    const watch = await start(events, errors, overflow)
    cleanups.push(() => watch.unsubscribe())
    const owner = schedule === 'unknown baseline' ? 0 : 1
    if (schedule === 'unknown baseline') {
      expect(subscriptions[0].unsubscribe).not.toHaveBeenCalled()
      expect(events).toHaveLength(0)
    } else {
      expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(POLL_MS)
      await vi.waitFor(() => expect(subscriptions).toHaveLength(2), {
        interval: 1,
        timeout: RECONCILE_MS / 2
      })
    }
    expect(fsControl.reads).toBe(1)
    subscriptions[owner].callback(null, [
      { type: 'update', path: join(fsControl.root, 'before-loss') }
    ])
    expect(events.flat()).toContainEqual({
      type: 'update',
      path: join(fsControl.root, 'before-loss')
    })
    const beforeLoss = events.length
    await rm(fsControl.root, { recursive: true })
    // Drop native deletion; a child-delete batch proves the missing-to-missing snapshot settled.
    await vi.advanceTimersByTimeAsync(RECONCILE_MS)
    await vi.waitFor(() =>
      expect(events.slice(beforeLoss).flat()).toContainEqual({
        type: 'delete',
        path: join(fsControl.root, 'same-child')
      })
    )
    const beforeLate = events.length
    lateDelivery(owner)
    expect.soft(events).toHaveLength(beforeLate)
    expect.soft(errors).not.toHaveBeenCalled()
    expect.soft(overflow).not.toHaveBeenCalled()
    expect.soft(subscriptions[owner].unsubscribe).toHaveBeenCalledOnce()
    await recreate()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(subscriptions).toHaveLength(owner + 2), {
      interval: 1,
      timeout: RECONCILE_MS / 2
    })
    subscriptions[owner + 1].callback(null, [
      { type: 'update', path: join(fsControl.root, 'fresh-after-loss') }
    ])
    expect(events.flat()).toContainEqual({
      type: 'update',
      path: join(fsControl.root, 'fresh-after-loss')
    })
    expect(subscriptions[owner].unsubscribe).toHaveBeenCalledOnce()
  }
)

it('keeps an ordinary polling baseline silent when the root is absent', async () => {
  await rm(fsControl.root, { recursive: true })
  const events = vi.fn()
  const watch = await startGitCommonPolling(common, events, POLL_MS, visible)
  cleanups.push(() => watch.unsubscribe())
  expect(events).not.toHaveBeenCalled()
})

it.each([
  [4, 4, 'ENOENT'],
  [40, 4, 'ENOENT'],
  [4, 40, 'ENOENT'],
  [4, 4, 'ENOTDIR'],
  [40, 4, 'ENOTDIR'],
  [4, 40, 'ENOTDIR']
] as const)(
  'bounds upgrade absence fanout with %i repos and %i entries (%s)',
  async (repoCount, entryCount, code) => {
    const makeConsumer = (path: string, count: number): ActiveWatch => ({
      key: path,
      kind: 'git-common',
      path,
      repos: new Map(
        Array.from({ length: count }, (_, i): [string, WorktreeBaseRepoWatchConfig] => {
          const repoId = `${path}:${i}`
          return [repoId, { repoId, repoName: `repo-${i}`, nestWorkspaces: false }]
        })
      ),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the consumer only calls isDestroyed.
      mainWindow: { isDestroyed: () => false } as never,
      subscription: { unsubscribe: async () => {} },
      notifyTimer: null,
      pendingStructureRepoIds: new Set(),
      pendingGitStatusRepoIds: new Set(),
      pendingHeadIdentityRepoIds: new Set(),
      pendingHeadIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE,
      pendingGitStatusScope: EMPTY_HEAD_IDENTITY_SCOPE,
      headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
      gitStatusRefPaths: new Set(),
      watcherFailureRefresh: new WorktreeWatcherFailureRefreshCooldown(),
      disposed: false
    })
    const seedEntries = async () => {
      await rm(fsControl.root, { recursive: true, force: true })
      await Promise.all(
        Array.from({ length: entryCount }, async (_, i) => {
          const entry = join(fsControl.root, `entry-${i}`)
          await mkdir(entry, { recursive: true })
          await writeFile(join(entry, 'HEAD'), 'a'.repeat(40))
          await writeFile(join(entry, 'gitdir'), join(common, `checkout-${i}`, '.git'))
        })
      )
    }
    await seedEntries()
    const consumer = makeConsumer(common, repoCount)
    const unrelated = makeConsumer(join(common, 'unrelated'), 1)
    const events: WorktreeBasePollEvent[][] = []
    const errors = vi.fn()
    const overflow = vi.fn()
    const reader = vi.spyOn(headReader, 'readGitCommonHeadIdentities')
    const catalog = vi.mocked(notifyWatchedWorktreeCatalogChanged)
    const counts = () => ({
      batches: events.length,
      catalogs: catalog.mock.calls.length,
      heads: reader.mock.calls.length,
      files: fsControl.files.length,
      statuses: vi.mocked(notifyWorktreeGitStatusMetadataChanged).mock.calls.length,
      identities: vi.mocked(notifyWorktreeHeadIdentitiesChanged).mock.calls.length
    })
    const blocked = Promise.withResolvers<void>()
    const reachedRead = vi.fn()
    native.mockRejectedValueOnce(
      new WatcherProcessFailure('test fuse', 'supervisor', 'supervisor_crash_fuse')
    )
    consumer.subscription = await startGitCommonNarrowWatch(
      consumer,
      (batch) => {
        events.push(batch)
        handleLocalWatchEvents(consumer, null, batch, () => [consumer, unrelated])
      },
      POLL_MS,
      'darwin',
      visible,
      undefined,
      errors,
      overflow
    )
    cleanups.push(() => consumer.subscription.unsubscribe())
    await refreshWorktreeHeadIdentities(consumer, consumer.headIdentityRefresh, false)
    native.mockImplementation(async (...args) => {
      const installed = await installNative(...args)
      await rm(fsControl.root, { recursive: true })
      fsControl.stat = async () => {
        fsControl.stat = null
        throw Object.assign(new Error('controlled root absence'), { code })
      }
      fsControl.read = async () => {
        reachedRead()
        await blocked.promise
      }
      return installed
    })
    const before = counts()
    const upgrading = fsControl.upgrade()
    try {
      await vi.waitFor(() => expect(reachedRead).toHaveBeenCalledOnce())
      expect(events.slice(before.batches)).toEqual([[{ type: 'delete', path: fsControl.root }]])
      expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
      // Keep the real baseline blocked, but allow the real head reader its own listing.
      fsControl.read = null
      await seedEntries()
      const reads = fsControl.reads
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(consumer.headIdentityRefresh.inFlight).toBe(false))
      expect(
        catalog.mock.calls
          .slice(before.catalogs)
          .map(([, id]) => id)
          .sort()
      ).toEqual([...consumer.repos.keys()].sort())
      expect(reader.mock.calls.slice(before.heads)).toHaveLength(1)
      expect(reader.mock.calls.at(-1)?.[0]).toBe(common)
      expect(reader.mock.calls.at(-1)?.[2]?.all).toBe(true)
      expect(fsControl.reads - reads).toBe(1)
      expect(fsControl.files.slice(before.files)).toHaveLength(entryCount * 2)
      expect(consumer.headIdentityRefresh.baseline?.size).toBe(entryCount)
      expect(unrelated.headIdentityRefresh.baseline).toBeNull()
      const beforeLate = counts()
      lateDelivery(0)
      await vi.advanceTimersByTimeAsync(250)
      expect(counts()).toEqual(beforeLate)
      expect(errors).not.toHaveBeenCalled()
      expect(overflow).not.toHaveBeenCalled()
      blocked.resolve()
      await upgrading
      // Upgrade resync and the two root-return signals may flush separately.
      native.mockImplementation(installNative)
      await vi.advanceTimersByTimeAsync(300)
      await vi.waitFor(() => expect(subscriptions).toHaveLength(2))
      await vi.waitFor(() =>
        expect(
          events.flat().filter((event) => event.type === 'create' && event.path === fsControl.root)
        ).toHaveLength(2)
      )
      await vi.advanceTimersByTimeAsync(300)
      await vi.waitFor(() => expect(consumer.headIdentityRefresh.inFlight).toBe(false))
      expect(consumer.notifyTimer).toBeNull()
      expect(catalog.mock.calls.length - beforeLate.catalogs).toBeGreaterThanOrEqual(repoCount)
      expect(catalog.mock.calls.length - beforeLate.catalogs).toBeLessThanOrEqual(3 * repoCount)
      expect(reader.mock.calls.length - beforeLate.heads).toBeGreaterThanOrEqual(1)
      expect(reader.mock.calls.length - beforeLate.heads).toBeLessThanOrEqual(3)
      expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
      // Real later loss gets one diff notification, then missing-to-missing ticks stay quiet.
      const beforeLoss = counts()
      await rm(fsControl.root, { recursive: true })
      await vi.advanceTimersByTimeAsync(RECONCILE_MS)
      await vi.waitFor(() => expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(consumer.headIdentityRefresh.baseline?.size).toBe(0))
      const absent = counts()
      expect(absent.catalogs - beforeLoss.catalogs).toBe(repoCount)
      expect(absent.heads - beforeLoss.heads).toBe(1)
      expect(
        events
          .slice(beforeLoss.batches)
          .flat()
          .filter((event) => event.path === fsControl.root && event.type === 'delete')
      ).toHaveLength(1)
      lateDelivery(1)
      await vi.advanceTimersByTimeAsync(RECONCILE_MS * 4)
      expect(counts()).toEqual(absent)
      expect(errors).not.toHaveBeenCalled()
      expect(overflow).not.toHaveBeenCalled()
      await seedEntries()
      await vi.advanceTimersByTimeAsync(POLL_MS)
      await vi.waitFor(() => expect(subscriptions).toHaveLength(3))
      await writeFile(join(fsControl.root, 'entry-0', 'HEAD'), 'b'.repeat(40))
      subscriptions[2].callback(null, [
        { type: 'update', path: join(fsControl.root, 'entry-0', 'HEAD') }
      ])
      await vi.advanceTimersByTimeAsync(300)
      await vi.waitFor(() => expect(consumer.headIdentityRefresh.inFlight).toBe(false))
      expect(catalog.mock.calls.length - absent.catalogs).toBe(repoCount)
      expect(reader.mock.calls.length).toBeGreaterThan(absent.heads)
      expect(consumer.headIdentityRefresh.baseline?.get(join(common, 'checkout-0'))).toBe(
        `${'b'.repeat(40)} `
      )
      expect(catalog.mock.calls.every(([, id]) => consumer.repos.has(id))).toBe(true)
      await consumer.subscription.unsubscribe()
      consumer.disposed = true
      const stopped = counts()
      lateDelivery(2)
      await vi.advanceTimersByTimeAsync(RECONCILE_MS * 4)
      expect(counts()).toEqual(stopped)
      expect(subscriptions[1].unsubscribe).toHaveBeenCalledOnce()
      expect(subscriptions[2].unsubscribe).toHaveBeenCalledOnce()
    } finally {
      fsControl.read = null
      blocked.resolve()
      await upgrading
      consumer.disposed = true
      clearTimeout(consumer.notifyTimer ?? undefined)
      reader.mockRestore()
    }
  }
)
