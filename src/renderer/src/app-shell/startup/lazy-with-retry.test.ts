import { afterEach, expect, it, vi } from 'vitest'
import { LazyChunkLoadError, loadLazyWithRetry } from './lazy-with-retry'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('contains an exhausted load without reloading once its caller no longer needs the chunk', async () => {
  const setItem = vi.fn()
  const reload = vi.fn()
  vi.stubGlobal('window', {
    sessionStorage: { getItem: () => null, setItem, removeItem: vi.fn() },
    location: { reload }
  })
  const factory = vi.fn(() =>
    Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'))
  )

  await expect(
    loadLazyWithRetry(factory, { retries: 1, baseDelayMs: 0, canRecover: () => false })
  ).rejects.toBeInstanceOf(LazyChunkLoadError)

  expect(factory).toHaveBeenCalledTimes(2)
  // The document's one reload attempt stays available to a caller that still needs its chunk.
  expect(setItem).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
})
