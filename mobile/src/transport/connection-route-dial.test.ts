import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionRouteDial } from './connection-route-dial'
import type { ConnectionRouteLease } from './connection-route'

afterEach(() => vi.useRealTimers())

it('cancels a pending route and closes its late lease without publishing it', async () => {
  const pending = Promise.withResolvers<ConnectionRouteLease>()
  const open = vi.fn((_endpoint: string, _signal: AbortSignal) => pending.promise)
  const dial = new ConnectionRouteDial({ open })
  const ready = vi.fn()
  const failed = vi.fn()
  dial.open('ws://server:6768', ready, failed)
  await Promise.resolve()
  dial.close()
  expect(open.mock.calls[0]?.[1].aborted).toBe(true)
  const close = vi.fn()
  pending.resolve({ endpoint: 'ws://127.0.0.1:12345', close })
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(ready).not.toHaveBeenCalled()
  expect(failed).not.toHaveBeenCalled()
})

it('releases the prior lease before publishing a replacement', async () => {
  const releases: string[] = []
  let port = 10000
  const dial = new ConnectionRouteDial({
    open: async () => {
      const endpoint = `ws://127.0.0.1:${port++}`
      return { endpoint, close: () => releases.push(endpoint) }
    }
  })
  const ready = vi.fn()
  dial.open('ws://server:6768', ready, vi.fn())
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  dial.open('ws://server:6768', ready, vi.fn())
  expect(releases).toEqual(['ws://127.0.0.1:10000'])
  await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2))
  dial.close()
  dial.close()
  expect(releases).toEqual(['ws://127.0.0.1:10000', 'ws://127.0.0.1:10001'])
})

it('bounds a hung provider and disposes a lease returned after timeout', async () => {
  vi.useFakeTimers()
  const pending = Promise.withResolvers<ConnectionRouteLease>()
  const dial = new ConnectionRouteDial({ open: () => pending.promise })
  const failed = vi.fn()
  const ready = vi.fn()
  dial.open('ws://server:6768', ready, failed)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ retryable: true }))
  const close = vi.fn()
  pending.resolve({ endpoint: 'ws://127.0.0.1:12345', close })
  await vi.advanceTimersByTimeAsync(0)
  expect(close).toHaveBeenCalledOnce()
  expect(ready).not.toHaveBeenCalled()
})

it('ignores a failed superseded attempt while the current route is pending', async () => {
  const first = Promise.withResolvers<ConnectionRouteLease>()
  const second = Promise.withResolvers<ConnectionRouteLease>()
  const open = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const dial = new ConnectionRouteDial({ open })
  const failed = vi.fn()
  dial.open('ws://server:6768', vi.fn(), failed)
  await Promise.resolve()
  dial.open('ws://server:6768', vi.fn(), failed)
  first.reject(new Error('old network'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(failed).not.toHaveBeenCalled()
  dial.close()
  second.resolve({ endpoint: 'ws://127.0.0.1:12345', close: vi.fn() })
})
