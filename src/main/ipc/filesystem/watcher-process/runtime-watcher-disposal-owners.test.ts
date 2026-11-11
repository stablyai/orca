import { expect, it, vi } from 'vitest'
import { RuntimeWatcherDisposalOwners } from './runtime-watcher-disposal-owners'

function owner() {
  return {
    dispose: vi.fn(),
    subscribe: vi.fn(),
    disposeAndWait: vi.fn(async () => {})
  }
}

it('retains retired cleanup and joins concurrent shutdown callers', async () => {
  const owners = new RuntimeWatcherDisposalOwners()
  const retired = owner()
  const pending = Promise.withResolvers<void>()
  retired.disposeAndWait.mockReturnValue(pending.promise)
  owners.retire(retired)
  const shutdown = owners.disposeAndWait(() => {})
  expect(owners.disposeAndWait(() => {})).toBe(shutdown)
  const finished = vi.fn()
  const result = shutdown.then(finished)
  await Promise.resolve()
  expect(finished).not.toHaveBeenCalled()
  expect(retired.disposeAndWait).toHaveBeenCalledOnce()
  pending.resolve()
  await result
  await owners.disposeAndWait(() => {})
  expect(retired.disposeAndWait).toHaveBeenCalledOnce()
})

it('does not retry a newly failed attempt until a later explicit shutdown call', async () => {
  const owners = new RuntimeWatcherDisposalOwners()
  const failed = owner()
  const sibling = owner()
  const pending = Promise.withResolvers<void>()
  const failure = new Error('child still live')
  failed.disposeAndWait.mockRejectedValueOnce(failure)
  sibling.disposeAndWait.mockReturnValue(pending.promise)
  const finished = vi.fn()
  const shutdown = owners.disposeAndWait(() => {
    owners.retire(failed)
    owners.retire(sibling)
  })
  const result = shutdown.catch((error: unknown) => {
    finished()
    return error
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).not.toHaveBeenCalled()
  expect(owners.disposeAndWait(() => {})).toBe(shutdown)
  expect(failed.disposeAndWait).toHaveBeenCalledOnce()
  pending.resolve()
  expect(await result).toMatchObject({ errors: [failure] })
  await owners.disposeAndWait(() => {})
  expect(failed.disposeAndWait).toHaveBeenCalledTimes(2)
  expect(sibling.disposeAndWait).toHaveBeenCalledOnce()
})

it('retains synchronous failures and attempts sibling owners', async () => {
  const owners = new RuntimeWatcherDisposalOwners()
  const failed = owner()
  const sibling = owner()
  failed.disposeAndWait.mockImplementationOnce(() => {
    throw new Error('sync failure')
  })
  await expect(
    owners.disposeAndWait(() => {
      owners.retire(failed)
      owners.retire(sibling)
    })
  ).rejects.toThrow('watcher_pool_shutdown_incomplete')
  expect(sibling.disposeAndWait).toHaveBeenCalledOnce()
  await owners.disposeAndWait(() => {})
  expect(failed.disposeAndWait).toHaveBeenCalledTimes(2)
})

it('publishes the retained attempt before a synchronous disposal callback reenters', async () => {
  const owners = new RuntimeWatcherDisposalOwners()
  const child = owner()
  const pending = Promise.withResolvers<void>()
  let nested: Promise<void> | undefined
  child.disposeAndWait.mockImplementation(() => {
    owners.retire(child)
    nested = owners.disposeAndWait(() => {})
    return pending.promise
  })
  const shutdown = owners.disposeAndWait(() => owners.retire(child))
  expect(nested).toBe(shutdown)
  expect(child.disposeAndWait).toHaveBeenCalledOnce()
  pending.resolve()
  await shutdown
})

it('refuses to acknowledge a supervisor without a physical-disposal API', async () => {
  const owners = new RuntimeWatcherDisposalOwners()
  const legacy = { dispose: vi.fn(), subscribe: vi.fn() }
  await expect(owners.disposeAndWait(() => owners.retire(legacy))).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: 'watcher_supervisor_awaited_disposal_unavailable' })
    ]
  })
  expect(legacy.dispose).toHaveBeenCalledOnce()
})
