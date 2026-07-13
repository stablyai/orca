import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WatcherProcessFailure } from '../main/ipc/parcel-watcher-process-failure'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from '../main/ipc/parcel-watcher-process-subscription'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'
import { createRelayWatcherProcessPool } from './relay-watcher-process-pool'

type InstalledWatch = {
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}

class FakeWatcherPool {
  readonly installed: InstalledWatch[] = []
  readonly dispose = vi.fn()
  readonly forgetRoot = vi.fn()

  async subscribe(
    _rootPath: string,
    callback: WatcherProcessCallback,
    _options: object,
    hooks: WatcherProcessHooks
  ): Promise<WatcherProcessSubscription> {
    const unsubscribe = vi.fn(async () => undefined)
    this.installed.push({ callback, hooks, unsubscribe })
    return { unsubscribe }
  }
}

function createDispatcher() {
  const detached = new Set<(clientId: number) => void>()
  return {
    notify: vi.fn(),
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
})

describe('createRelayWatcherProcessPool', () => {
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
