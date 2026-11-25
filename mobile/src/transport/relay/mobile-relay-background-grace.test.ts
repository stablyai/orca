import { expect, it } from 'vitest'
import { MobileRelayBackgroundGraceTimer } from './mobile-relay-background-grace'

function harness(graceMs: () => number) {
  let now = 0
  const scheduled: { handler: () => void; ms: number }[] = []
  let expired = 0
  const timer = new MobileRelayBackgroundGraceTimer(
    {
      now: () => now,
      setTimer: (handler, ms) => {
        scheduled.push({ handler, ms })
        return setTimeout(() => {}, 0)
      },
      clearTimer: (handle) => clearTimeout(handle),
      relayBackgroundGraceMs: graceMs
    },
    () => {
      expired += 1
    }
  )
  return { timer, scheduled, setNow: (value: number) => (now = value), expired: () => expired }
}

it('uses the injected grace for both the deadline and the scheduled delay', () => {
  const h = harness(() => 1_200)
  h.timer.arm()
  expect(h.scheduled[0]?.ms).toBe(1_200)
  h.setNow(1_199)
  expect(h.timer.consumeExpired()).toBe(false)
  h.timer.arm()
  h.setNow(1_199 + 1_200)
  expect(h.timer.consumeExpired()).toBe(true)
})

it('ignores an expiry callback left over from before a rearm', () => {
  const h = harness(() => 900)
  h.timer.arm()
  const stale = h.scheduled[0]!.handler
  h.timer.clear()
  h.timer.arm()
  stale()
  expect(h.expired()).toBe(0)
})
