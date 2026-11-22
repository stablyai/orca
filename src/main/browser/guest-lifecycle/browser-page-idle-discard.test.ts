import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserPageIdleDiscard } from './browser-page-idle-discard'
import type { BrowserGuestIdleDiscardRequest } from '../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  let now = 0
  let awake = true
  let powerChanged = (): void => {}
  const requests: BrowserGuestIdleDiscardRequest[] = []
  const scheduler = createBrowserPageIdleDiscard({
    now: () => now,
    awake: () => awake,
    subscribe: (changed) => {
      powerChanged = changed
      return () => {}
    }
  })
  stops.push(() => scheduler.dispose())
  const report = (visible: boolean | null, generation = 1, guestId = 1, pageId = 'page') =>
    scheduler.report(
      { browserPageId: pageId, webContentsId: guestId, visible, generation },
      99,
      (request) => requests.push(request)
    )
  return {
    scheduler,
    requests,
    report,
    async advance(ms: number, awakeMs = ms) {
      now += awakeMs
      await vi.advanceTimersByTimeAsync(ms)
    },
    power(value: boolean) {
      awake = value
      powerChanged()
    }
  }
}

it('attempts once at four awake hidden hours, with no page-count threshold or protection retry', async () => {
  const f = fixture()
  f.report(false)
  await f.advance(14_399_999)
  expect(f.requests).toEqual([])
  // Duplicate registration and protection/activity updates do not start a new episode.
  f.report(false)
  await f.advance(1)
  expect(f.requests.map((request) => request.browserPageId)).toEqual(['page'])
  const request = f.requests[0]
  expect(f.scheduler.admit('page', 1, request.policyToken)).toBe(true)
  f.scheduler.refuse('page', 1, request.policyToken)
  f.report(false)
  await f.advance(28_800_000)
  expect(f.requests).toHaveLength(1)
  f.report(true, 2)
  f.report(false, 3)
  await f.advance(14_400_000)
  expect(f.requests).toHaveLength(2)
})

it('protects visible and unknown surfaces and rejects due requests after activation or replacement', async () => {
  const f = fixture()
  f.report(true, 1, 1, 'active')
  f.report(null, 1, 2, 'unknown')
  f.report(false, 1, 3, 'hidden')
  await f.advance(14_400_000)
  expect(f.requests.map((request) => request.browserPageId)).toEqual(['hidden'])
  const old = f.requests[0]
  f.report(true, 2, 3, 'hidden')
  f.report(false, 3, 3, 'hidden')
  expect(f.scheduler.admit('hidden', 3, old.policyToken)).toBe(false)
  f.report(false, 4, 4, 'hidden')
  expect(f.scheduler.admit('hidden', 3, old.policyToken)).toBe(false)
  await f.advance(14_400_000)
  expect(f.requests.map((request) => request.webContentsId)).toEqual([3, 4])
})

it('preserves logical revisits through guest replacement and cold restore, and forgets them on close', async () => {
  const f = fixture()
  let generation = 1
  f.report(true, generation++)
  for (let revisit = 0; revisit < 15; revisit++) {
    f.report(false, generation++)
    f.report(true, generation++)
  }
  f.report(false, generation++)
  await f.advance(14_400_000)
  expect(f.requests).toHaveLength(1)
  f.scheduler.retired('page', 1)
  f.scheduler.destroyed('page', 1)
  f.report(null, generation++, 2)
  f.report(true, generation++, 2)
  f.report(false, generation++, 2)
  await f.advance(14_400_000)
  expect(f.requests).toHaveLength(1)
  f.scheduler.close('page')
  f.report(false, generation++, 3)
  await f.advance(14_400_000)
  expect(f.requests.map((request) => request.webContentsId)).toEqual([1, 3])
})

it('excludes sleep, retains the awake remainder and defers reservation while power is suspended', async () => {
  const f = fixture()
  f.report(false)
  await f.advance(7_200_000)
  f.power(false)
  await f.advance(28_800_000, 0)
  expect(f.requests).toEqual([])
  f.power(true)
  await f.advance(7_199_999)
  expect(f.requests).toEqual([])
  await f.advance(1)
  const request = f.requests[0]
  f.power(false)
  expect(f.scheduler.admit('page', 1, request.policyToken)).toBe(false)
  await f.advance(28_800_000, 0)
  expect(f.requests).toHaveLength(1)
  f.power(true)
  await f.advance(1)
  expect(f.requests).toHaveLength(2)
  expect(f.scheduler.admit('page', 1, f.requests[1].policyToken)).toBe(true)
})

it('queues due pages behind four native removals and resumes on destruction without a retention cap', async () => {
  const f = fixture()
  for (let id = 1; id <= 6; id++) {
    f.report(false, 1, id, `page-${id}`)
  }
  await f.advance(14_400_000)
  expect(f.requests).toHaveLength(4)
  for (const request of f.requests) {
    f.scheduler.retired(request.browserPageId, request.webContentsId)
  }
  await f.advance(14_400_000)
  expect(f.requests).toHaveLength(4)
  f.scheduler.destroyed(f.requests[0].browserPageId, f.requests[0].webContentsId)
  await f.advance(1)
  expect(f.requests).toHaveLength(5)
  f.scheduler.destroyed(f.requests[1].browserPageId, f.requests[1].webContentsId)
  await f.advance(1)
  expect(f.requests).toHaveLength(6)
})

it('follows live Memory Saver changes: off stops waiting and in-flight frees, hours re-key from when the page hid', async () => {
  const f = fixture()
  f.report(false, 1, 1, 'waiting')
  f.report(false, 1, 2, 'due')
  await f.advance(3_600_000)
  f.scheduler.configure({ enabled: true, idleMs: 3_600_000 })
  await f.advance(0)
  const due = f.requests.splice(0)
  expect(due.map((request) => request.browserPageId)).toEqual(['waiting', 'due'])
  f.scheduler.refuse('waiting', 1, due[0].policyToken)
  f.scheduler.configure({ enabled: false, idleMs: 3_600_000 })
  expect(f.scheduler.admit('due', 2, due[1].policyToken)).toBe(false)
  f.report(true, 2, 1, 'waiting')
  f.report(false, 3, 1, 'waiting')
  await f.advance(28_800_000)
  expect(f.requests).toEqual([])
  // Back on with 12 hours, 9 awake hours after 'due' hid and 8 after 'waiting' hid again.
  f.scheduler.configure({ enabled: true, idleMs: 43_200_000 })
  await f.advance(10_799_999)
  expect(f.requests).toEqual([])
  await f.advance(1)
  expect(f.requests.map((request) => request.browserPageId)).toEqual(['due'])
  await f.advance(3_600_000)
  expect(f.requests.map((request) => request.browserPageId)).toEqual(['due', 'waiting'])
})

it('counts for the perf notice only pages hidden that long while awake and that Memory Saver could free', async () => {
  const f = fixture()
  // Memory Saver off: the notice is what suggests turning it on.
  f.scheduler.configure({ enabled: false, idleMs: 14_400_000 })
  f.report(false, 1, 1, 'clean')
  f.report(false, 1, 2, 'pdf')
  const canFree = (pageId: string): boolean => pageId !== 'pdf'
  // Eight hours pass, but the machine slept for all but half an hour of them.
  await f.advance(28_800_000, 1_800_000)
  expect(f.scheduler.countHiddenLoadedPages(14_400_000, canFree)).toBe(0)
  await f.advance(12_600_000)
  expect(f.scheduler.countHiddenLoadedPages(14_400_000, canFree)).toBe(1)
})
