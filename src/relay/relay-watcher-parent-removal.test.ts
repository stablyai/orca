import { describe, expect, it, vi } from 'vitest'
import type {
  WatcherProcessHooks,
  WatcherProcessSubscription
} from '../main/ipc/parcel-watcher-process-subscription'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'

class ParentRemovalPool {
  readonly subscriptions: { rootPath: string; unsubscribe: ReturnType<typeof vi.fn> }[] = []
  readonly dispose = vi.fn()
  readonly forgetRoot = vi.fn()

  async subscribe(
    rootPath: string,
    _callback: unknown,
    _options: unknown,
    _hooks: WatcherProcessHooks
  ): Promise<WatcherProcessSubscription> {
    const unsubscribe = vi.fn(async () => undefined)
    this.subscriptions.push({ rootPath, unsubscribe })
    return { unsubscribe }
  }
}

function context(clientId: number): RequestContext {
  return { clientId, isStale: () => false }
}

describe('RelayFilesystemWatchRegistry parent removal', () => {
  it.each([
    ['/repo', '/repo/nested', '/repo-sibling'],
    ['C:\\Repo', 'c:\\repo\\nested', 'C:\\Repo-Sibling']
  ])(
    'closes descendant watches before deleting parent %s and preserves siblings',
    async (parent, descendant, sibling) => {
      const pool = new ParentRemovalPool()
      const dispatcher = { notify: vi.fn(), notifyClient: vi.fn(), onClientDetached: vi.fn() }
      const registry = new RelayFilesystemWatchRegistry(
        dispatcher as unknown as RelayDispatcher,
        pool
      )
      await registry.watch(descendant, context(1), 101)
      await registry.watch(sibling, context(2), 202)
      const remove = vi.fn(async () => {
        expect(pool.subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
        expect(pool.subscriptions[1].unsubscribe).not.toHaveBeenCalled()
      })

      await registry.runWithRemovalFence(parent, remove)

      expect(remove).toHaveBeenCalledOnce()
      expect(dispatcher.notifyClient).toHaveBeenCalledWith(1, 'fs.watchFailed', {
        rootPath: descendant,
        watchId: 101,
        message: 'Remote worktree is being removed'
      })
    }
  )

  it('waits for a descendant setup and closes its published subscription before removal', async () => {
    const pool = new ParentRemovalPool()
    const dispatcher = { notify: vi.fn(), notifyClient: vi.fn(), onClientDetached: vi.fn() }
    const registry = new RelayFilesystemWatchRegistry(
      dispatcher as unknown as RelayDispatcher,
      pool
    )
    let releaseSetup: () => void = () => undefined
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve
    })
    const subscribe = pool.subscribe.bind(pool)
    vi.spyOn(pool, 'subscribe').mockImplementation(async (...args) => {
      await setupGate
      return subscribe(...args)
    })

    const watch = registry.watch('/repo/nested', context(1), 101)
    const remove = vi.fn(async () => {
      expect(pool.subscriptions[0].unsubscribe).toHaveBeenCalledOnce()
    })
    const removal = registry.runWithRemovalFence('/repo', remove)
    await Promise.resolve()
    expect(remove).not.toHaveBeenCalled()

    releaseSetup()
    await Promise.all([watch, removal])
    expect(remove).toHaveBeenCalledOnce()
  })

  it('waits for an already-retiring descendant before removal', async () => {
    const pool = new ParentRemovalPool()
    const dispatcher = { notify: vi.fn(), notifyClient: vi.fn(), onClientDetached: vi.fn() }
    const registry = new RelayFilesystemWatchRegistry(
      dispatcher as unknown as RelayDispatcher,
      pool
    )
    await registry.watch('/repo/nested', context(1), 101)
    let releaseTeardown: () => void = () => undefined
    pool.subscriptions[0].unsubscribe.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseTeardown = resolve
        })
    )
    const teardown = registry.unwatchAndWait('/repo/nested', context(1))
    const remove = vi.fn(async () => undefined)
    const removal = registry.runWithRemovalFence('/repo', remove)
    await Promise.resolve()
    expect(remove).not.toHaveBeenCalled()

    releaseTeardown()
    await Promise.all([teardown, removal])
    expect(remove).toHaveBeenCalledOnce()
  })
})
