import { afterEach, expect, it, vi } from 'vitest'
import { CancellableProviderRequests } from './cancellable-provider-requests'

afterEach(() => vi.useRealTimers())

it('bounds unmatched cancellations while retaining recent cancel-before-run requests', async () => {
  const requests = new CancellableProviderRequests()
  for (let id = 0; id <= 1024; id++) {
    requests.cancel(`request-${id}`)
  }
  await expect(requests.run('request-0', async (signal) => signal.aborted)).resolves.toBe(false)
  await expect(requests.run('request-1024', async (signal) => signal.aborted)).resolves.toBe(true)
})

it('expires abandoned cancellations without requiring another cancellation', async () => {
  vi.useFakeTimers()
  const requests = new CancellableProviderRequests()
  requests.cancel('abandoned')
  vi.advanceTimersByTime(30_001)
  await expect(requests.run('abandoned', async (signal) => signal.aborted)).resolves.toBe(false)
})
