import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RelayDispatcher } from './dispatcher'
import { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'

function fixture() {
  const unsubscribe = vi.fn(async () => {})
  const pool = {
    subscribe: vi.fn(async () => ({ unsubscribe })),
    forgetRoot: vi.fn(),
    dispose: vi.fn(),
    disposeAndWait: vi.fn(async () => {})
  }
  const registry = new RelayFilesystemWatchRegistry({} as RelayDispatcher, pool)
  const root = join(tmpdir(), 'orca-watcher-shutdown-fixture')
  return { registry, pool, unsubscribe, root }
}

it('fences new watches synchronously and joins an in-flight native unsubscribe', async () => {
  const f = fixture()
  await f.registry.watch(f.root)
  const pending = Promise.withResolvers<void>()
  f.unsubscribe.mockReturnValue(pending.promise)
  const finished = vi.fn()
  const shutdown = f.registry.closeWatchesAndWait().then(finished)
  const duplicate = f.registry.closeWatchesAndWait()
  await expect(f.registry.watch(f.root)).rejects.toThrow('relay_watcher_shutdown_fenced')
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).not.toHaveBeenCalled()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
  expect(f.pool.dispose).not.toHaveBeenCalled()
  pending.resolve()
  await Promise.all([shutdown, duplicate])
  expect(f.pool.forgetRoot).toHaveBeenCalledWith(f.root)
})

it('retains failed teardown and retries without admitting replacement watches', async () => {
  const f = fixture()
  await f.registry.watch(f.root)
  const failure = new Error('native close failed')
  f.unsubscribe.mockRejectedValueOnce(failure)
  await expect(f.registry.closeWatchesAndWait()).rejects.toMatchObject({
    message: 'relay_watcher_shutdown_incomplete',
    errors: [failure]
  })
  expect(f.pool.forgetRoot).not.toHaveBeenCalled()
  await expect(f.registry.watch(f.root)).rejects.toThrow('relay_watcher_shutdown_fenced')
  await f.registry.closeWatchesAndWait()
  expect(f.unsubscribe).toHaveBeenCalledTimes(2)
  expect(f.pool.forgetRoot).toHaveBeenCalledOnce()
})

it('waits for a late subscription and its unsubscribe after setup has begun', async () => {
  const f = fixture()
  const setup = Promise.withResolvers<{ unsubscribe: () => Promise<void> }>()
  f.pool.subscribe.mockReturnValue(setup.promise as ReturnType<typeof f.pool.subscribe>)
  const watch = f.registry.watch(f.root)
  const finished = vi.fn()
  const shutdown = f.registry.closeWatchesAndWait().then(finished)
  const close = Promise.withResolvers<void>()
  f.unsubscribe.mockReturnValue(close.promise)
  setup.resolve({ unsubscribe: f.unsubscribe })
  await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledOnce())
  expect(finished).not.toHaveBeenCalled()
  close.resolve()
  await Promise.all([watch, shutdown])
  expect(f.pool.subscribe).toHaveBeenCalledOnce()
})

it('joins teardown already started by client unwatch', async () => {
  const f = fixture()
  await f.registry.watch(f.root)
  const close = Promise.withResolvers<void>()
  f.unsubscribe.mockReturnValue(close.promise)
  f.registry.unwatch(f.root)
  const finished = vi.fn()
  const shutdown = f.registry.closeWatchesAndWait().then(finished)
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).not.toHaveBeenCalled()
  close.resolve()
  await shutdown
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('retains a late subscription whose cleanup fails instead of treating it as failed setup', async () => {
  const f = fixture()
  const setup = Promise.withResolvers<{ unsubscribe: () => Promise<void> }>()
  f.pool.subscribe.mockReturnValue(setup.promise as ReturnType<typeof f.pool.subscribe>)
  const failure = new Error('late native close failed')
  f.unsubscribe.mockRejectedValueOnce(failure)
  const watch = f.registry.watch(f.root).catch((error: unknown) => error)
  const shutdown = f.registry.closeWatchesAndWait().catch((error: unknown) => error)
  setup.resolve({ unsubscribe: f.unsubscribe })
  expect(await watch).toBe(failure)
  expect(await shutdown).toMatchObject({
    message: 'relay_watcher_shutdown_incomplete',
    errors: [failure]
  })
  expect(f.pool.forgetRoot).not.toHaveBeenCalled()
  await f.registry.closeWatchesAndWait()
  expect(f.unsubscribe).toHaveBeenCalledTimes(2)
  expect(f.pool.forgetRoot).toHaveBeenCalledOnce()
})

it('does not publish a replacement watch when its predecessor closes after shutdown fencing', async () => {
  const f = fixture()
  await f.registry.watch(f.root)
  const close = Promise.withResolvers<void>()
  f.unsubscribe.mockReturnValue(close.promise)
  f.registry.unwatch(f.root)
  const replacement = f.registry.watch(f.root).catch((error: unknown) => error)
  const shutdown = f.registry.closeWatchesAndWait()
  close.resolve()
  expect(await replacement).toMatchObject({ message: 'relay_watcher_shutdown_fenced' })
  await shutdown
  expect(f.pool.subscribe).toHaveBeenCalledOnce()
})

it('full watcher disposal waits for physical pool exit after native unsubscribe completes', async () => {
  const f = fixture()
  await f.registry.watch(f.root)
  const pending = Promise.withResolvers<void>()
  f.pool.disposeAndWait.mockReturnValue(pending.promise)
  const finished = vi.fn()
  const shutdown = f.registry.disposeAndWait().then(finished)
  await vi.waitFor(() => expect(f.pool.forgetRoot).toHaveBeenCalledOnce())
  expect(finished).not.toHaveBeenCalled()
  pending.resolve()
  await shutdown
})

it('does not acknowledge a failed pool exit after native subscriptions close', async () => {
  const f = fixture()
  await f.registry.watch(f.root)
  const error = new Error('pool exit unproven')
  f.pool.disposeAndWait.mockRejectedValueOnce(error)
  await expect(f.registry.disposeAndWait()).rejects.toMatchObject({ errors: [error] })
  await f.registry.disposeAndWait()
})
