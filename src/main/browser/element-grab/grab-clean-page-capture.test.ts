import { afterEach, expect, it, vi } from 'vitest'
import { captureCleanGuestPage } from './grab-clean-page-capture'
import { RendererPublicationThrottle } from '../../window/visibility/renderer-publication-throttle'

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
  // Draw gives up, but paint stays held while the native readback is still in flight.
  expect(paint).toEqual(['hold'])

  // The abandoned readback still owns the guest's one native slot.
  await expect(
    captureCleanGuestPage(guest, new AbortController().signal, holdPaint, 1_000)
  ).resolves.toBeNull()
  expect(readbacks).toHaveLength(1)

  readbacks[0]()
  await vi.advanceTimersByTimeAsync(0)
  expect(paint).toEqual(['hold', 'release'])
  const next = captureCleanGuestPage(guest, new AbortController().signal, holdPaint, 1_000)
  readbacks[1]()
  await expect(next).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
})

it('runs the paint lease restore capture only after an abandoned readback settles', async () => {
  vi.useFakeTimers()
  const throttle = new RendererPublicationThrottle()
  const calls: string[] = []
  let finishReadback: (() => void) | undefined
  const guest = {
    isDestroyed: () => false,
    isFocused: () => false,
    setBackgroundThrottling: () => {},
    capturePage: (rect?: unknown) => {
      if (rect) {
        // The lease's visibility restore.
        calls.push('restore')
        return Promise.resolve(image)
      }
      calls.push('readback')
      return new Promise<typeof image>((resolve) => {
        finishReadback = () => resolve(image)
      })
    }
  }

  const draw = captureCleanGuestPage(
    guest,
    new AbortController().signal,
    () => throttle.acquire(guest),
    1_000
  )
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(draw).resolves.toBeNull()
  await vi.advanceTimersByTimeAsync(100)
  expect(calls).toEqual(['readback'])

  finishReadback?.()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toEqual(['readback', 'restore'])
})

it('leaves the guest usable for the next Draw when taking the paint lease fails', async () => {
  const guest = { isDestroyed: () => false, capturePage: () => Promise.resolve(image) }
  await expect(
    captureCleanGuestPage(guest, new AbortController().signal, () => {
      throw new Error('parent renderer lease failed')
    })
  ).resolves.toBeNull()
  await expect(
    captureCleanGuestPage(guest, new AbortController().signal, () => () => {})
  ).resolves.toEqual({ dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 })
})
