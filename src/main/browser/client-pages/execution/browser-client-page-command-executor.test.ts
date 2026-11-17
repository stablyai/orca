import { expect, it, vi } from 'vitest'
import {
  createCommand,
  createHarness,
  createLifecycleClaim
} from './browser-client-page-command-executor-test-harness'

function closeCommand(generation = 7) {
  return createCommand('navigate', {
    pageReconciliationProtocolVersion: 1,
    pageHostGeneration: generation,
    command: {
      type: 'closePage',
      targetAuthority: {
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'client-a',
        browserHostGeneration: 3,
        pageHostGeneration: generation
      }
    }
  })
}

it('retries the exact failed renderer cleanup without releasing joined resources twice', async () => {
  const h = createHarness()
  const signal = new AbortController().signal
  await h.executor.handle(createCommand('createPage'), signal)
  h.renderer.retirePage.mockRejectedValueOnce(new Error('retirement-reply-lost'))
  expect(await h.executor.handle(closeCommand(), signal)).toMatchObject({ status: 'failed' })
  expect(h.executor.snapshotPageInventory()).toMatchObject([{ state: 'outcomeUnknown' }])
  expect(h.route.release).toHaveBeenCalledTimes(1)
  expect(h.routeSession.release).toHaveBeenCalledTimes(1)
  expect(await h.executor.handle(createCommand('navigate'), signal)).toMatchObject({
    status: 'failed'
  })
  expect(await h.executor.handle(closeCommand(8), signal)).toMatchObject({ status: 'failed' })
  expect(h.renderer.retirePage).toHaveBeenCalledTimes(1)
  expect(await h.executor.handle(closeCommand(), signal)).toEqual({ status: 'completed' })
  expect(h.renderer.retirePage).toHaveBeenCalledTimes(2)
  expect(h.dependencies.retireAutomation).toHaveBeenCalledTimes(1)
  expect(h.route.release).toHaveBeenCalledTimes(1)
  expect(h.routeSession.release).toHaveBeenCalledTimes(1)
  expect(h.executor.snapshotPageInventory()).toEqual([])
  expect(await h.executor.handle(closeCommand(), signal)).toMatchObject({ status: 'failed' })
  await h.executor.close()
})

it('joins concurrent cleanup callers and holds resources until exact native destruction', async () => {
  const h = createHarness()
  const destroyed = Promise.withResolvers<void>()
  h.dependencies.routeWebContents.claimGuestLifecycle.mockImplementationOnce((registration) =>
    createLifecycleClaim(registration, destroyed.promise)
  )
  await h.executor.handle(createCommand('createPage'), new AbortController().signal)
  const first = h.executor.retirePage('page-a', 7)
  const second = h.executor.retirePage('page-a', 7)
  await vi.waitFor(() => expect(h.renderer.retirePage).toHaveBeenCalledTimes(1))
  expect(h.route.release).not.toHaveBeenCalled()
  expect(h.routeSession.release).not.toHaveBeenCalled()
  expect(h.executor.snapshotPageInventory()).toMatchObject([{ state: 'outcomeUnknown' }])
  destroyed.resolve()
  expect(await Promise.all([first, second])).toEqual([true, true])
  expect(h.route.release).toHaveBeenCalledTimes(1)
  expect(h.routeSession.release).toHaveBeenCalledTimes(1)
  expect(h.executor.snapshotPageInventory()).toEqual([])
  await h.executor.close()
})

it('keeps an unsuccessful one-shot route release unresolved through retry and teardown', async () => {
  const h = createHarness()
  await h.executor.handle(createCommand('createPage'), new AbortController().signal)
  h.route.release.mockRejectedValueOnce(new Error('route-close-failed'))
  await expect(h.executor.retirePage('page-a', 7)).rejects.toThrow(
    'Browser client page cleanup failed'
  )
  await expect(h.executor.retirePage('page-a', 7)).rejects.toThrow(
    'Browser client page cleanup failed'
  )
  expect(h.route.release).toHaveBeenCalledTimes(1)
  expect(h.renderer.retirePage).toHaveBeenCalledTimes(1)
  expect(h.executor.snapshotPageInventory()).toMatchObject([{ state: 'outcomeUnknown' }])
  await expect(h.executor.close()).rejects.toThrow('Browser client page executor cleanup failed')
  expect(h.route.release).toHaveBeenCalledTimes(1)
})
