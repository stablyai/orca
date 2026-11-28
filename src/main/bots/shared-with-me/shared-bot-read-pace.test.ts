import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { InviteWakeEvent } from '../../connector-cloud/connector-invite-wake'
import { SharedBotReadPace } from './shared-bot-read-pace'

const MINUTE_MS = 60_000

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
})
afterEach(() => {
  vi.useRealTimers()
})

function pace(randoms: number[]) {
  let wake: (event: InviteWakeEvent) => void = () => {}
  const reads: number[] = []
  const pace = new SharedBotReadPace({
    invites: {
      up: true,
      listen: (listener) => {
        wake = listener
        return () => {}
      }
    },
    nextReadMs: () => null,
    read: () => reads.push(Date.now()),
    now: () => Date.now(),
    random: () => randoms.shift() ?? 0
  })
  return { pace, reads, wake: (event: InviteWakeEvent) => wake(event) }
}

it('reads once more for a share change that arrives while a read is out', async () => {
  // Spreads of 1 s, then 1.8 s: the second change keeps the first change's earlier timer.
  const { pace: readPace, reads, wake } = pace([0.5, 0.9])
  wake('shares-changed')
  await vi.advanceTimersByTimeAsync(500)
  readPace.began()
  await vi.advanceTimersByTimeAsync(300)
  wake('shares-changed')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(reads).toEqual([1_000])
})

it('catches up on a reopen when the last read failed', async () => {
  const { pace: readPace, reads, wake } = pace([0])
  readPace.began()
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS)
  wake('opened')
  await vi.advanceTimersByTimeAsync(0)
  expect(reads).toHaveLength(1)
})

it('skips the reopen read within ten minutes of a read that succeeded', async () => {
  const { pace: readPace, reads, wake } = pace([0])
  readPace.began()
  readPace.settled(true)
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS)
  wake('opened')
  await vi.advanceTimersByTimeAsync(MINUTE_MS)
  expect(reads).toHaveLength(0)
})
