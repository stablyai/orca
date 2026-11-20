import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  GRAB_EDITABLE_WATCH_BURST,
  GRAB_EDITABLE_WATCH_REFILL_MS,
  GuestEditableWatch
} from './grab-guest-editable-watch'

// Perf contract: a page that answers at once with alternating values (or churns focus) must not make main and the
// page trade messages without limit. Over one second the watch asks at most one burst plus one per refill.

afterEach(() => vi.useRealTimers())

it('bounds round-trips under page-driven churn and answers "unknown" while the budget is spent', async () => {
  vi.useFakeTimers()
  let asked = 0
  let flip = false
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async () => {
      asked += 1
      flip = !flip
      return flip
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watch only calls executeJavaScriptInIsolatedWorld, on/off and isDestroyed, which this fixture implements.
  const watch = new GuestEditableWatch(guest as unknown as Electron.WebContents)

  watch.start()
  await vi.advanceTimersByTimeAsync(1000)

  expect(asked).toBeLessThanOrEqual(
    GRAB_EDITABLE_WATCH_BURST + 1000 / GRAB_EDITABLE_WATCH_REFILL_MS + 1
  )
  watch.stop()
  const afterStop = asked
  await vi.advanceTimersByTimeAsync(1000)
  expect(asked).toBe(afterStop)
})
