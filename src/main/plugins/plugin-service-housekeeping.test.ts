import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginDevWatcher } from './plugin-dev-watcher'
import { PluginServiceHousekeeping } from './plugin-service-housekeeping'

vi.mock('./plugin-dev-watcher', () => ({
  PluginDevWatcher: vi.fn(function () {
    return { start: vi.fn(), dispose: vi.fn(), checkRootBindings: vi.fn().mockResolvedValue(false) }
  })
}))

let housekeeping: PluginServiceHousekeeping

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  housekeeping = new PluginServiceHousekeeping()
})

afterEach(() => {
  housekeeping.dispose()
  vi.useRealTimers()
})

function watcher(): PluginDevWatcher {
  const instance = vi.mocked(PluginDevWatcher).mock.results[0]?.value
  if (!(instance instanceof Object) || !('start' in instance) || !('dispose' in instance)) {
    throw new Error('Plugin watcher mock missing')
  }
  return instance
}

function sync() {
  const reapIdle = vi.fn<() => void>()
  const refresh = vi.fn<() => void>()
  housekeeping.sync({ enabled: true, devPaths: ['plugin'], reapIdle, refresh })
  return { reapIdle, refresh }
}

function failRegistration(): void {
  const onWatcherError = vi.mocked(watcher().start).mock.calls[0]?.[2]
  if (!onWatcherError) {
    throw new Error('Registration failure callback missing')
  }
  onWatcherError()
}

describe('PluginServiceHousekeeping', () => {
  it('checks bindings and reaps healthy workers without refreshing or restarting watchers', async () => {
    const { reapIdle, refresh } = sync()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(reapIdle).toHaveBeenCalledTimes(3)
    expect(refresh).not.toHaveBeenCalled()
    expect(watcher().start).toHaveBeenCalledOnce()
    expect(watcher().checkRootBindings).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('retries failed registration using the existing maintenance interval', async () => {
    const { reapIdle, refresh } = sync()
    failRegistration()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(reapIdle).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    housekeeping.sync({ enabled: true, devPaths: ['plugin'], reapIdle, refresh })
    expect(watcher().start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('retains a synchronous startup failure for the next bounded retry', async () => {
    vi.mocked(watcher().start).mockImplementation((_paths, _refresh, onWatcherError) => {
      onWatcherError?.()
    })
    const { refresh } = sync()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps unchanged missing roots idle and refreshes when their binding appears', async () => {
    const { refresh, reapIdle } = sync()
    const onWatcherError = vi.mocked(watcher().start).mock.calls[0]?.[2]
    onWatcherError?.(false)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(watcher().start).toHaveBeenCalledOnce()
    vi.mocked(watcher().checkRootBindings).mockResolvedValueOnce(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledOnce()
    housekeeping.sync({ enabled: true, devPaths: ['plugin'], reapIdle, refresh })
    expect(watcher().start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('coalesces slow binding checks and ignores their results after disposal', async () => {
    let resolveCheck: (changed: boolean) => void = () => undefined
    vi.mocked(watcher().checkRootBindings).mockImplementation(
      () => new Promise((resolve) => (resolveCheck = resolve))
    )
    const { refresh } = sync()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(watcher().checkRootBindings).toHaveBeenCalledOnce()
    housekeeping.dispose()
    resolveCheck(true)
    await Promise.resolve()
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks new paths while the previous generation has a pending filesystem check', async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    vi.mocked(watcher().checkRootBindings).mockReturnValueOnce(promise)
    const { refresh, reapIdle } = sync()
    await vi.advanceTimersByTimeAsync(60_000)
    housekeeping.sync({ enabled: true, devPaths: ['next'], reapIdle, refresh })
    vi.mocked(watcher().checkRootBindings).mockResolvedValueOnce(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(watcher().checkRootBindings).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledOnce()
    resolve(true)
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('stops retries and releases subscriptions when disabled or disposed', () => {
    const { reapIdle, refresh } = sync()
    failRegistration()
    housekeeping.sync({ enabled: false, devPaths: ['plugin'], reapIdle, refresh })
    vi.advanceTimersByTime(120_000)
    expect(reapIdle).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    sync()
    failRegistration()
    housekeeping.dispose()
    vi.advanceTimersByTime(120_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
