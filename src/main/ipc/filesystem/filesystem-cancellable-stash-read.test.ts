import { describe, expect, it, vi } from 'vitest'
import { runCancellableStashRead } from './filesystem-cancellable-stash-read'

describe('cancellable stash read lifetime', () => {
  it('keeps the cancellation registration until the provider settles', async () => {
    const controller = new AbortController()
    const finish = vi.fn()
    const cancellations = {
      begin: vi.fn(() => controller),
      finish,
      cancel: vi.fn()
    }
    let resolveRead: ((value: string) => void) | undefined
    const request = runCancellableStashRead(
      cancellations,
      {} as never,
      'request-1',
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        })
    )

    expect(finish).not.toHaveBeenCalled()
    resolveRead?.('done')
    await expect(request).resolves.toBe('done')
    expect(finish).toHaveBeenCalledWith(expect.anything(), 'request-1', controller)
  })
})
