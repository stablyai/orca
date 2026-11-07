import { expect, it, vi } from 'vitest'
import { RuntimeWatcherProcessPool } from './runtime-watcher-process-pool'
import type { WatcherProcessHooks } from './parcel-watcher-process-subscription'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'

function supervisor() {
  const pending = Promise.withResolvers<void>()
  let hooks: WatcherProcessHooks | undefined
  return {
    pending,
    dispose: vi.fn(),
    disposeAndWait: vi.fn(() => pending.promise),
    subscribe: vi.fn(
      async (
        _dir: string,
        _callback: unknown,
        _options: unknown,
        options?: WatcherProcessHooks
      ) => {
        hooks = options
        return { unsubscribe: vi.fn(async () => {}) }
      }
    ),
    fail: () =>
      hooks?.onTerminalError?.(
        new WatcherProcessFailure('failed', 'supervisor', 'process_unavailable')
      )
  }
}

it('awaits retired and replacement supervisors after logical retirement removed the old slot', async () => {
  const old = supervisor()
  const current = supervisor()
  const create = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(current)
  const pool = new RuntimeWatcherProcessPool({ createSupervisor: create })
  await pool.subscribe('/first', vi.fn(), {})
  old.fail()
  await new Promise((resolve) => setImmediate(resolve))
  expect(old.disposeAndWait).toHaveBeenCalledOnce()
  await pool.subscribe('/second', vi.fn(), {})
  const finished = vi.fn()
  const shutdown = pool.disposeAndWait()
  expect(pool.disposeAndWait()).toBe(shutdown)
  const result = shutdown.then(finished)
  current.pending.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).not.toHaveBeenCalled()
  await expect(pool.subscribe('/third', vi.fn(), {})).rejects.toThrow('disposed')
  expect(create).toHaveBeenCalledTimes(2)
  old.pending.resolve()
  await result
})

it('retains failure after synchronous pool disposal and retries it explicitly', async () => {
  const child = supervisor()
  const failure = new Error('child still running')
  child.disposeAndWait.mockRejectedValueOnce(failure)
  const pool = new RuntimeWatcherProcessPool({ createSupervisor: () => child })
  await pool.subscribe('/first', vi.fn(), {})
  const shutdown = pool.disposeAndWait()
  await expect(shutdown).rejects.toMatchObject({ errors: [failure] })
  const retry = pool.disposeAndWait()
  expect(child.disposeAndWait).toHaveBeenCalledTimes(2)
  child.pending.resolve()
  await retry
})

it('does not duplicate termination when a queued retirement races with synchronous disposal', async () => {
  const child = supervisor()
  const pool = new RuntimeWatcherProcessPool({ createSupervisor: () => child })
  await pool.subscribe('/first', vi.fn(), {})
  child.fail()
  pool.dispose()
  const shutdown = pool.disposeAndWait()
  await new Promise((resolve) => setImmediate(resolve))
  expect(child.disposeAndWait).toHaveBeenCalledOnce()
  child.pending.resolve()
  await shutdown
})
