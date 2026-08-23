import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserRetentionBudget } from '../../shared/browser-retention-budget'
import { OffscreenBrowserPageReclaimer } from './offscreen-browser-page-reclaimer'
import type {
  OffscreenBrowserOpenPages,
  OffscreenBrowserPage
} from './offscreen-browser-open-pages'

// Why: the reclaimer replaced a fixed sweep with a deadline it computes itself,
// so the scheduling contract is now load-bearing — an idle host must hold no
// timer, a woken page must re-arm one, and a deadline that fires with nothing to
// do must never re-arm at zero.

const BUDGET: BrowserRetentionBudget = {
  limit: 2,
  idleMs: 60_000,
  graceMs: 5_000
}

function page(browserPageId: string, lastActivityAt: number): OffscreenBrowserPage {
  return {
    browserPageId,
    worktreeId: undefined,
    profileId: undefined,
    partition: 'persist:test',
    url: 'https://example.test/',
    title: '',
    window: {} as OffscreenBrowserPage['window'],
    activeWhenParked: false,
    loading: false,
    loadError: null,
    lastActivityAt
  }
}

function createReclaimer(
  args: {
    pages?: OffscreenBrowserPage[]
    pinned?: readonly string[]
    park?: (browserPageId: string, live: Map<string, OffscreenBrowserPage>) => Promise<void>
    budget?: BrowserRetentionBudget
  } = {}
) {
  const live = new Map<string, OffscreenBrowserPage>(
    (args.pages ?? []).map((entry) => [entry.browserPageId, entry])
  )
  const clock = { value: 1_000_000 }
  const parked: string[] = []
  const pages = {
    get: (browserPageId: string) => live.get(browserPageId),
    resident: () => [...live.values()]
  } as unknown as OffscreenBrowserOpenPages
  const reclaimer = new OffscreenBrowserPageReclaimer({
    pages,
    budget: args.budget ?? BUDGET,
    isReleasing: () => false,
    isWaking: () => false,
    hasCertificateChallenge: () => false,
    hasActiveDownload: () => false,
    isHostPinned: (browserPageId) => (args.pinned ?? []).includes(browserPageId),
    park: async (browserPageId) => {
      if (args.park) {
        await args.park(browserPageId, live)
        return
      }
      live.delete(browserPageId)
      parked.push(browserPageId)
    },
    now: () => clock.value
  })
  return { reclaimer, clock, live, parked }
}

describe('OffscreenBrowserPageReclaimer scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms nothing when no page is resident', () => {
    const { reclaimer } = createReclaimer()
    reclaimer.reschedule()
    expect(reclaimer.isScheduled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('arms the idle deadline for a page inside the limit', () => {
    const { reclaimer, clock } = createReclaimer({
      pages: [page('a', 1_000_000)]
    })
    reclaimer.reschedule()
    expect(reclaimer.isScheduled).toBe(true)

    // Nothing fires before the idle window closes.
    clock.value += BUDGET.idleMs - 1
    vi.advanceTimersByTime(BUDGET.idleMs - 1)
    expect(reclaimer.isScheduled).toBe(true)
  })

  it('parks on its own deadline with no periodic sweep in between', async () => {
    const { reclaimer, clock, parked } = createReclaimer({
      pages: [page('a', 1_000_000)]
    })
    reclaimer.reschedule()

    clock.value += BUDGET.idleMs
    await vi.advanceTimersByTimeAsync(BUDGET.idleMs)

    expect(parked).toEqual(['a'])
    // Why: the last resident page is gone, so the host goes quiet entirely.
    expect(reclaimer.isScheduled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('parks the coldest page first when the limit is exceeded', async () => {
    const { reclaimer, clock, parked } = createReclaimer({
      pages: [page('newest', 1_000_000), page('middle', 990_000), page('oldest', 980_000)]
    })
    clock.value += BUDGET.graceMs
    reclaimer.reschedule()
    await vi.advanceTimersByTimeAsync(BUDGET.graceMs)

    expect(parked).toEqual(['oldest'])
  })

  it('re-asks on a bounded cadence while a pin holds a page over the limit', async () => {
    const { reclaimer, clock, parked } = createReclaimer({
      pages: [page('a', 1_000_000), page('b', 1_000_000), page('pinned', 900_000)],
      pinned: ['pinned']
    })
    clock.value += BUDGET.graceMs
    reclaimer.reschedule()

    await vi.advanceTimersByTimeAsync(BUDGET.graceMs * 4)
    expect(parked).toEqual([])
    // Still watching, because releasing that pin raises no event this can see.
    expect(reclaimer.isScheduled).toBe(true)
  })

  it('never re-arms at zero after a sweep that parks nothing', async () => {
    // Why: a deadline that lands earlier than the moment a page truly becomes
    // evictable would otherwise spin the timer flat out on an idle server.
    let attempts = 0
    const { reclaimer, clock } = createReclaimer({
      pages: [page('a', 1_000_000), page('b', 1_000_000), page('stuck', 500_000)],
      park: async (browserPageId, live) => {
        if (browserPageId !== 'stuck') {
          return
        }
        attempts += 1
        // Why the escape hatch: without the backoff this re-arms at 0ms, and a
        // test that hangs reports far worse than one that fails.
        if (attempts > 100) {
          live.delete(browserPageId)
        }
      }
    })
    clock.value += BUDGET.graceMs
    reclaimer.reschedule()

    await vi.advanceTimersByTimeAsync(BUDGET.graceMs * 10)
    // One try per backoff window, not an unbounded spin.
    expect(attempts).toBeGreaterThan(0)
    expect(attempts).toBeLessThanOrEqual(11)
  })

  it('stops holding a timer once stopped', () => {
    const { reclaimer } = createReclaimer({ pages: [page('a', 1_000_000)] })
    reclaimer.reschedule()
    expect(reclaimer.isScheduled).toBe(true)
    reclaimer.stop()
    expect(reclaimer.isScheduled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off instead of spinning when a park rejects', async () => {
    // Why: a rejection used to skip the backoff assignment entirely, and the
    // next reschedule saw a deadline in the past with zero backoff — an
    // instant re-sweep that failed the same way, pegging an idle host.
    let attempts = 0
    const { reclaimer, clock } = createReclaimer({
      pages: [page('a', 1_000_000), page('b', 1_000_000), page('stuck', 500_000)],
      park: async (browserPageId, live) => {
        if (browserPageId !== 'stuck') {
          return
        }
        attempts += 1
        if (attempts > 100) {
          live.delete(browserPageId)
          return
        }
        throw new Error('helper session teardown failed')
      }
    })
    clock.value += BUDGET.graceMs
    reclaimer.reschedule()

    await vi.advanceTimersByTimeAsync(BUDGET.graceMs * 10)
    expect(attempts).toBeGreaterThan(0)
    expect(attempts).toBeLessThanOrEqual(11)
  })

  it('caps the armed delay below the setTimeout ceiling', () => {
    // Why: Node clamps a delay past 2^31-1ms to 1ms — a documented "set the
    // idle window very high" configuration would otherwise spin the sweep at
    // 1ms forever on an idle host.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const { reclaimer } = createReclaimer({
      pages: [page('a', 1_000_000)],
      budget: { ...BUDGET, idleMs: 100_000_000_000 }
    })
    reclaimer.reschedule()

    expect(reclaimer.isScheduled).toBe(true)
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number)
    expect(delays.length).toBeGreaterThan(0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_147_483_647)
  })

  it('arms nothing when stop lands while a sweep is in flight', async () => {
    // Why: stop() clears sweepInFlight, so without a terminal flag the sweep's
    // own re-arm no longer sees itself in flight and schedules a fresh check
    // after shutdown.
    let releasePark = (): void => {}
    const gate = new Promise<void>((resolve) => (releasePark = resolve))
    const { reclaimer, clock } = createReclaimer({
      pages: [page('a', 1_000_000), page('b', 1_000_000), page('over', 500_000)],
      park: async () => {
        await gate
      }
    })
    clock.value += BUDGET.graceMs
    reclaimer.reschedule()
    await vi.advanceTimersByTimeAsync(BUDGET.graceMs)

    reclaimer.stop()
    releasePark()
    await vi.advanceTimersByTimeAsync(0)

    expect(reclaimer.isScheduled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
