import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginDevWatcher } from './plugin-dev-watcher'

afterEach(() => {
  vi.useRealTimers()
})

describe('PluginDevWatcher', () => {
  it('contains asynchronous watcher errors and requests a retrying refresh', async () => {
    vi.useFakeTimers()
    let onEvent!: (error: Error | null) => void
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    const subscribePath = vi.fn(async (_path, callback: typeof onEvent) => {
      onEvent = callback
      return { unsubscribe }
    })
    const devWatcher = new PluginDevWatcher(subscribePath)
    const refresh = vi.fn()
    const onWatcherError = vi.fn()
    devWatcher.start(['/plugins/demo'], refresh, onWatcherError)
    await vi.waitFor(() => expect(subscribePath).toHaveBeenCalledOnce())

    expect(() => onEvent(new Error('watch failed'))).not.toThrow()
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
    expect(onWatcherError).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(300)
    expect(refresh).toHaveBeenCalledOnce()

    devWatcher.dispose()
  })

  it('unsubscribes a subscription that resolves after disposal', async () => {
    let resolveSubscription!: (value: { unsubscribe: () => Promise<void> }) => void
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    const subscribePath = vi.fn(
      () =>
        new Promise<{ unsubscribe: () => Promise<void> }>((resolve) => {
          resolveSubscription = resolve
        })
    )
    const devWatcher = new PluginDevWatcher(subscribePath)

    devWatcher.start(['/plugins/demo'], vi.fn())
    devWatcher.dispose()
    resolveSubscription({ unsubscribe })

    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
  })

  it('does not spin refreshes when a missing path cannot be subscribed', async () => {
    vi.useFakeTimers()
    const subscribePath = vi.fn().mockRejectedValue(new Error('missing path'))
    const refresh = vi.fn()
    const onWatcherError = vi.fn()
    const devWatcher = new PluginDevWatcher(subscribePath)

    devWatcher.start(['/plugins/missing'], refresh, onWatcherError)
    await vi.waitFor(() => expect(onWatcherError).toHaveBeenCalledOnce())
    vi.advanceTimersByTime(10_000)

    expect(refresh).not.toHaveBeenCalled()
    devWatcher.dispose()
  })
})
