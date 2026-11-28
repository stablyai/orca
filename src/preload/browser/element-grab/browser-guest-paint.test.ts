import { afterEach, expect, it, vi } from 'vitest'
import { GUEST_PAINT_WAIT_MS, waitForGuestPaint } from './browser-guest-paint'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// A guest that renders one frame every `frameMs`, like a loaded machine right after a page load.
function framesEvery(frameMs: number): void {
  let next = 0
  const pending = new Map<number, ReturnType<typeof setTimeout>>()
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
    const id = ++next
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id)
        callback(0)
      }, frameMs)
    )
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    clearTimeout(pending.get(id))
    pending.delete(id)
  })
}

it('confirms paint on a guest that renders only a few frames a second after a load', async () => {
  vi.useFakeTimers()
  framesEvery(300)
  const painted = waitForGuestPaint()
  await vi.advanceTimersByTimeAsync(600)
  await expect(painted).resolves.toBe(true)
})

it('reports no paint when the guest renders no frame within the wait', async () => {
  vi.useFakeTimers()
  framesEvery(60_000)
  let settled: boolean | undefined
  void waitForGuestPaint().then((painted) => {
    settled = painted
  })
  await vi.advanceTimersByTimeAsync(GUEST_PAINT_WAIT_MS - 1)
  expect(settled).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(settled).toBe(false)
})
