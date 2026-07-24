import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WatcherProcessFailure } from '../main/ipc/parcel-watcher-process-failure'
import { WatcherProcessSupervisor } from '../main/ipc/parcel-watcher-process-supervisor'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from '../main/ipc/parcel-watcher-process-subscription'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'
import { createRelayWatcherProcessPool } from './relay-watcher-process-pool'

type InstalledWatch = {
  rootPath: string
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}

type InstalledSupervisorWatch = Omit<InstalledWatch, 'rootPath'> & { dir: string }

function stubRelayWatcherSupervisors() {
  const installed = new Map<WatcherProcessSupervisor, InstalledSupervisorWatch[]>()
  vi.spyOn(WatcherProcessSupervisor.prototype, 'subscribe').mockImplementation(function (
    this: WatcherProcessSupervisor,
    dir,
    callback,
    _options,
    hooks = {}
  ) {
    const watches = installed.get(this) ?? []
    const unsubscribe = vi.fn(async () => undefined)
    watches.push({ dir, callback, hooks, unsubscribe })
    installed.set(this, watches)
    return Promise.resolve({ unsubscribe })
  })
  const dispose = vi
    .spyOn(WatcherProcessSupervisor.prototype, 'dispose')
    .mockImplementation(() => undefined)
  return { installed, dispose }
}

class FakeWatcherPool {
  readonly installed: InstalledWatch[] = []
  readonly dispose = vi.fn()
  readonly forgetRoot = vi.fn()

  async subscribe(
    rootPath: string,
    callback: WatcherProcessCallback,
    _options: object,
    hooks: WatcherProcessHooks
  ): Promise<WatcherProcessSubscription> {
    const unsubscribe = vi.fn(async () => undefined)
    this.installed.push({ rootPath, callback, hooks, unsubscribe })
    return { unsubscribe }
  }
}

function createDispatcher() {
  const detached = new Set<(clientId: number) => void>()
  return {
    notify: vi.fn(),
    notifyClient: vi.fn(),
    onClientDetached: vi.fn((listener: (clientId: number) => void) => {
      detached.add(listener)
      return () => detached.delete(listener)
    })
  }
}

function context(clientId: number): RequestContext {
  return { clientId, isStale: () => false }
}

describe('RelayFilesystemWatchRegistry', () => {
  let dispatcher: ReturnType<typeof createDispatcher>
  let pool: FakeWatcherPool
  let registry: RelayFilesystemWatchRegistry

  beforeEach(() => {
    dispatcher = createDispatcher()
    pool = new FakeWatcherPool()
    registry = new RelayFilesystemWatchRegistry(dispatcher as unknown as RelayDispatcher, pool)
  })

  it('emits overflow around child replacement and resumes ordered event delivery', async () => {
    await registry.watch('/repo', context(1))
    const first = pool.installed[0]

    first.callback(null, [{ type: 'create', path: '/repo/before.txt' }])
    first.hooks.onInterruption?.()
    first.callback(null, [{ type: 'update', path: '/repo/after-resubscribe.txt' }])

    expect(dispatcher.notify.mock.calls).toEqual([
      ['fs.changed', { events: [{ kind: 'create', absolutePath: '/repo/before.txt' }] }],
      ['fs.changed', { events: [{ kind: 'overflow', absolutePath: '/repo' }] }],
      ['fs.changed', { events: [{ kind: 'update', absolutePath: '/repo/after-resubscribe.txt' }] }]
    ])
  })

  it('moves a terminal shard failure into recovery without dropping shared clients', async () => {
    await registry.watch('/repo', context(1))
    await registry.watch('/repo', context(2))
    const first = pool.installed[0]
    first.hooks.onTerminalError?.(
      new WatcherProcessFailure(
        'file watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      )
    )
    await Promise.resolve()

    expect(pool.installed).toHaveLength(2)
    pool.installed[1].callback(null, [{ type: 'create', path: '/repo/recovered.txt' }])
    expect(dispatcher.notify).toHaveBeenNthCalledWith(1, 'fs.changed', {
      events: [{ kind: 'overflow', absolutePath: '/repo' }]
    })
    expect(dispatcher.notify).toHaveBeenNthCalledWith(2, 'fs.changed', {
      events: [{ kind: 'create', absolutePath: '/repo/recovered.txt' }]
    })

    registry.unwatch('/repo', context(1))
    expect(pool.installed[1].unsubscribe).not.toHaveBeenCalled()
    registry.unwatch('/repo', context(2))
    expect(pool.installed[1].unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('notifies each owning client when bounded recovery terminates a live watch', async () => {
    await registry.watch('/repo', context(1), 101)
    await registry.watch('/repo', context(2), 202)
    const first = pool.installed[0]
    vi.spyOn(pool, 'subscribe').mockRejectedValueOnce(new Error('quarantine recovery failed'))

    first.hooks.onTerminalError?.(
      new WatcherProcessFailure(
        'file watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      )
    )

    await vi.waitFor(() => expect(dispatcher.notifyClient).toHaveBeenCalledTimes(2))
    expect(dispatcher.notifyClient).toHaveBeenNthCalledWith(1, 1, 'fs.watchFailed', {
      rootPath: '/repo',
      watchId: 101,
      message: 'quarantine recovery failed'
    })
    expect(dispatcher.notifyClient).toHaveBeenNthCalledWith(2, 2, 'fs.watchFailed', {
      rootPath: '/repo',
      watchId: 202,
      message: 'quarantine recovery failed'
    })
  })

  it('aborts a pending crawl only after the last same-root client leaves', async () => {
    let sharedSignal: AbortSignal | undefined
    let rejectSubscribe: ((error: Error) => void) | undefined
    vi.spyOn(pool, 'subscribe').mockImplementation(
      (_rootPath, _callback, _options, hooks): Promise<WatcherProcessSubscription> =>
        new Promise<WatcherProcessSubscription>((_resolve, reject) => {
          sharedSignal = hooks.signal
          rejectSubscribe = reject
          hooks.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new WatcherProcessFailure(
                  'file watcher subscription aborted',
                  'subscription',
                  'subscribe_aborted'
                )
              ),
            { once: true }
          )
        })
    )
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = registry.watch('/repo', {
      ...context(1),
      signal: firstAbort.signal
    })
    const second = registry.watch('/repo', {
      ...context(2),
      signal: secondAbort.signal
    })

    firstAbort.abort()
    await first
    expect(sharedSignal?.aborted).toBe(false)

    secondAbort.abort()
    await second
    expect(sharedSignal?.aborted).toBe(true)
    expect(rejectSubscribe).toBeDefined()
  })

  it('propagates unexpected non-Error setup failures', async () => {
    vi.spyOn(pool, 'subscribe').mockRejectedValueOnce('native setup failed')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(registry.watch('/repo', context(1))).rejects.toBe('native setup failed')
    } finally {
      stderr.mockRestore()
    }
  })

  it('rejects acknowledged teardown while another client still owns the watch', async () => {
    await registry.watch('/repo', context(1))
    await registry.watch('/repo', context(2))
    const unsubscribe = pool.installed[0].unsubscribe

    await expect(registry.unwatchAndWait('/repo', context(1))).rejects.toThrow(
      'still watched by another client'
    )
    expect(unsubscribe).not.toHaveBeenCalled()

    registry.unwatch('/repo', context(1))
    expect(unsubscribe).not.toHaveBeenCalled()
    registry.unwatch('/repo', context(2))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('notifies old clients and fences new ones while removal owns the root', async () => {
    await registry.watch('/repo', context(1), 101)
    let failRemoval: (error: Error) => void = () => undefined
    const removal = registry.runWithRemovalFence(
      '/repo',
      () =>
        new Promise<void>((_resolve, reject) => {
          failRemoval = reject
        })
    )
    await vi.waitFor(() => expect(pool.installed[0].unsubscribe).toHaveBeenCalledTimes(1))
    expect(dispatcher.notifyClient).toHaveBeenCalledWith(1, 'fs.watchFailed', {
      rootPath: '/repo',
      watchId: 101,
      message: 'Remote worktree is being removed'
    })

    await expect(registry.watch('/repo', context(2))).rejects.toThrow(
      'deletion already in progress'
    )
    failRemoval(new Error('Git removal failed'))
    await expect(removal).rejects.toThrow('Git removal failed')

    await expect(registry.watch('/repo', context(2))).resolves.toBeUndefined()
  })

  it('waits admitted PTY creation, rejects late creation, then tears down before removal', async () => {
    const finishPtyCreation = registry.beginWorktreePtySpawn('/repo/nested')
    const order: string[] = []
    registry.setWorktreePtyTeardown(async (rootPath) => {
      order.push(`pty:${rootPath}`)
    })

    const removal = registry.runWithRemovalFence('/repo', async () => {
      order.push('remove')
    })
    await Promise.resolve()
    expect(order).toEqual([])
    expect(() => registry.beginWorktreePtySpawn('/repo/late')).toThrow(
      'deletion already in progress'
    )

    finishPtyCreation()
    await removal
    expect(order).toEqual(['pty:/repo', 'remove'])
  })

  it.each([
    ['drive spelling', 'C:\\Repo', 'c:/repo/'],
    ['UNC spelling', '\\\\Server\\Share\\Repo', '//server/share/repo/']
  ])('shares one Windows root across equivalent %s', async (_label, firstPath, secondPath) => {
    await registry.watch(firstPath, context(1))
    await registry.watch(secondPath, context(2))

    expect(pool.installed).toHaveLength(1)
    expect(pool.installed[0].rootPath).toBe(firstPath)
    await expect(registry.unwatchAndWait(secondPath, context(1))).rejects.toThrow(
      'still watched by another client'
    )

    registry.unwatch(secondPath, context(1))
    await registry.unwatchAndWait(firstPath, context(2))

    expect(pool.installed[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(pool.forgetRoot).toHaveBeenCalledWith(firstPath)
  })

  it('keeps literal POSIX backslash roots physically distinct', async () => {
    await registry.watch('/srv/team\\repo', context(1))
    await registry.watch('/srv/team/repo', context(2))

    expect(pool.installed.map(({ rootPath }) => rootPath)).toEqual([
      '/srv/team\\repo',
      '/srv/team/repo'
    ])

    await registry.unwatchAndWait('/srv/team\\repo', context(1))
    await registry.unwatchAndWait('/srv/team/repo', context(2))
  })

  it('retains pending-setup teardown failure until the child physically exits', async () => {
    let resolveSubscribe: (subscription: WatcherProcessSubscription) => void = () => undefined
    let resolvePhysicalExit: () => void = () => undefined
    const physicalExit = new Promise<void>((resolve) => {
      resolvePhysicalExit = resolve
    })
    const terminationError = new WatcherProcessFailure(
      'file watcher process did not exit after termination deadline',
      'supervisor',
      'process_unavailable',
      physicalExit
    )
    const unsubscribe = vi.fn().mockRejectedValue(terminationError)
    vi.spyOn(pool, 'subscribe').mockImplementation(
      () =>
        new Promise<WatcherProcessSubscription>((resolve) => {
          resolveSubscribe = resolve
        })
    )

    const watch = registry.watch('/repo', context(1))
    const close = registry.unwatchAndWait('/repo', context(1))
    resolveSubscribe({ unsubscribe })

    await expect(watch).rejects.toBe(terminationError)
    await expect(close).rejects.toBe(terminationError)
    await expect(registry.unwatchAndWait('/repo', context(1))).rejects.toBe(terminationError)
    expect(pool.forgetRoot).not.toHaveBeenCalled()

    resolvePhysicalExit()
    await physicalExit
    await Promise.resolve()

    await expect(registry.unwatchAndWait('/repo', context(1))).resolves.toBeUndefined()
    expect(pool.forgetRoot).toHaveBeenCalledWith('/repo')
  })
})

describe('createRelayWatcherProcessPool', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses one healthy watcher process per SSH host for each standard repo', async () => {
    const { installed } = stubRelayWatcherSupervisors()
    const firstHostPool = createRelayWatcherProcessPool()
    const secondHostPool = createRelayWatcherProcessPool()
    const repoBase = join(tmpdir(), 'ssh-repo')
    const roots = [repoBase, join(repoBase, '.git'), join(repoBase, 'worktree')]
    try {
      for (const root of roots) {
        await firstHostPool.subscribe(root, vi.fn(), {}, {})
        await secondHostPool.subscribe(root, vi.fn(), {}, {})
      }

      expect(
        Array.from(installed.values()).map((watches) => watches.map(({ dir }) => dir))
      ).toEqual([roots, roots])
    } finally {
      firstHostPool.dispose()
      secondHostPool.dispose()
    }
  })

  it('quarantines and recovers each standard-repo root after the shared child fails', async () => {
    const { installed, dispose } = stubRelayWatcherSupervisors()
    const pool = createRelayWatcherProcessPool()
    const dispatcher = createDispatcher()
    const registry = new RelayFilesystemWatchRegistry(
      dispatcher as unknown as RelayDispatcher,
      pool
    )
    const repoBase = join(tmpdir(), 'ssh-repo-recovery')
    const roots = [repoBase, join(repoBase, '.git'), join(repoBase, 'worktree')]
    try {
      for (const root of roots) {
        await registry.watch(root, context(1))
      }
      const healthyWatches = Array.from(installed.values())[0]
      const failure = new WatcherProcessFailure(
        'file watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      )

      for (const watch of healthyWatches) {
        watch.hooks.onTerminalError?.(failure)
      }
      await Promise.resolve()

      const recoveredWatches = Array.from(installed.values()).slice(1)
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(recoveredWatches.map((watches) => watches.map(({ dir }) => dir))).toEqual(
        roots.map((root) => [root])
      )
      expect(dispatcher.notify.mock.calls.slice(0, roots.length)).toEqual(
        roots.map((root) => ['fs.changed', { events: [{ kind: 'overflow', absolutePath: root }] }])
      )

      for (const watches of recoveredWatches) {
        const [{ callback, dir }] = watches
        callback(null, [{ type: 'update', path: join(dir, 'recovered.txt') }])
      }
      expect(dispatcher.notify.mock.calls.slice(roots.length)).toEqual(
        roots.map((root) => [
          'fs.changed',
          {
            events: [{ kind: 'update', absolutePath: join(root, 'recovered.txt') }]
          }
        ])
      )
    } finally {
      registry.dispose()
    }
  })

  it('fails closed instead of loading the native watcher in the relay process', async () => {
    const previousVitest = process.env.VITEST
    process.env.VITEST = 'true'
    const pool = createRelayWatcherProcessPool(
      join(tmpdir(), `missing-relay-watcher-${process.pid}.js`)
    )
    try {
      await expect(pool.subscribe('/repo', vi.fn(), {}, {})).rejects.toMatchObject({
        code: 'entry_missing'
      })
    } finally {
      pool.dispose()
      if (previousVitest === undefined) {
        delete process.env.VITEST
      } else {
        process.env.VITEST = previousVitest
      }
    }
  })
})
