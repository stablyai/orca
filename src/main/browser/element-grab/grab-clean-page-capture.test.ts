import { afterEach, expect, it, vi } from 'vitest'
import { captureCleanGuestPage } from './grab-clean-page-capture'

afterEach(() => vi.useRealTimers())

const image = {
  isEmpty: () => false,
  toDataURL: () => 'data:image/png;base64,AA',
  getSize: () => ({ width: 8, height: 8 })
}

it('abandons a stalled readback at its deadline, and starts no second readback until it settles', async () => {
  vi.useFakeTimers()
  const readbacks: (() => void)[] = []
  const guest = {
    isDestroyed: () => false,
    capturePage: () =>
      new Promise<typeof image>((resolve) => {
        readbacks.push(() => resolve(image))
      })
  }
  const paint: string[] = []
  const holdPaint = (): (() => void) => {
    paint.push('hold')
    return () => paint.push('release')
  }

  const stalled = captureCleanGuestPage(guest, new AbortController().signal, holdPaint, 1_000)
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(stalled).resolves.toBeNull()
  expect(paint).toEqual(['hold', 'release'])

  // The abandoned readback still owns the guest's one native slot.
  await expect(
    captureCleanGuestPage(guest, new AbortController().signal, holdPaint, 1_000)
  ).resolves.toBeNull()
  expect(readbacks).toHaveLength(1)

  readbacks[0]()
  await vi.advanceTimersByTimeAsync(0)
  const next = captureCleanGuestPage(guest, new AbortController().signal, holdPaint, 1_000)
  readbacks[1]()
  await expect(next).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
})
