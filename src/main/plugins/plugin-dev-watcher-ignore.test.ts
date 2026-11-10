import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WatcherProcessCallback } from '../ipc/filesystem/watcher-process/parcel-watcher-process-subscription'
import type { WatcherProcessSubscribeOptions } from '../ipc/filesystem/watcher-process/parcel-watcher-process-protocol'
import { PluginDevWatcher } from './plugin-dev-watcher'

const root = resolve('plugins', 'demo')
const watchers: PluginDevWatcher[] = []

afterEach(() => {
  for (const watcher of watchers.splice(0)) {
    watcher.dispose()
  }
  vi.useRealTimers()
})

describe('PluginDevWatcher ignore list', () => {
  function start() {
    vi.useFakeTimers()
    const subscribed: {
      options: WatcherProcessSubscribeOptions
      callback: WatcherProcessCallback
    }[] = []
    const watcher = new PluginDevWatcher(async (_path, callback, options) => {
      subscribed.push({ options, callback })
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) }
    })
    watchers.push(watcher)
    const refresh = vi.fn()
    watcher.start([root], refresh)
    const rootSubscription = subscribed.find((entry) => entry.options.mode !== 'shallow')
    if (!rootSubscription) {
      throw new Error('missing root subscription')
    }
    return { refresh, rootSubscription }
  }

  it('does not refresh for a batch of ignored paths, but does for a mixed batch', async () => {
    const { refresh, rootSubscription } = start()
    await vi.advanceTimersByTimeAsync(300)
    refresh.mockClear()

    rootSubscription.callback(null, [
      { type: 'update', path: join(root, 'node_modules', 'pkg', 'index.js') },
      { type: 'create', path: join(root, '.orca', 'types', 'orca.d.ts') },
      { type: 'update', path: join(root, '.DS_Store') }
    ])
    await vi.advanceTimersByTimeAsync(300)
    expect(refresh).not.toHaveBeenCalled()

    rootSubscription.callback(null, [
      { type: 'update', path: join(root, '.git', 'index') },
      { type: 'update', path: join(root, 'main.mjs') }
    ])
    await vi.advanceTimersByTimeAsync(300)
    expect(refresh).toHaveBeenCalledOnce()
  })
})
