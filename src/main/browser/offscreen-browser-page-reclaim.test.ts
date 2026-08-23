import { afterEach, describe, expect, it } from 'vitest'
import {
  selectBrowserRetentionEvictions,
  type BrowserRetentionBudget,
  type BrowserRetentionCandidate
} from '../../shared/browser-retention-budget'
import {
  nextOffscreenBrowserReclaimCheckAt,
  readOffscreenBrowserRetentionBudget,
  OFFSCREEN_BROWSER_IDLE_PARK_MS,
  OFFSCREEN_BROWSER_PARK_GRACE_MS,
  OFFSCREEN_BROWSER_PINNED_RECHECK_MS,
  OFFSCREEN_BROWSER_RESIDENT_LIMIT
} from './offscreen-browser-page-reclaim'

const NOW = 1_000_000
const BUDGET: BrowserRetentionBudget = {
  limit: 2,
  idleMs: 60_000,
  graceMs: 5_000
}

function used(id: string, msAgo: number): BrowserRetentionCandidate {
  return { id, lastActivityAt: NOW - msAgo }
}

function nextCheck(
  candidates: readonly BrowserRetentionCandidate[],
  pinned: readonly string[] = [],
  now = NOW,
  budget = BUDGET
): number | null {
  return nextOffscreenBrowserReclaimCheckAt({
    candidates,
    isPinned: (id) => pinned.includes(id),
    now,
    budget
  })
}

describe('readOffscreenBrowserRetentionBudget', () => {
  const KEYS = [
    'ORCA_HEADLESS_BROWSER_RESIDENT_LIMIT',
    'ORCA_HEADLESS_BROWSER_PARK_IDLE_MS',
    'ORCA_HEADLESS_BROWSER_PARK_GRACE_MS'
  ]
  afterEach(() => {
    for (const key of KEYS) {
      delete process.env[key]
    }
  })

  it('defaults to the shipped policy', () => {
    expect(readOffscreenBrowserRetentionBudget()).toEqual({
      limit: OFFSCREEN_BROWSER_RESIDENT_LIMIT,
      idleMs: OFFSCREEN_BROWSER_IDLE_PARK_MS,
      graceMs: OFFSCREEN_BROWSER_PARK_GRACE_MS
    })
  })

  it('reads each knob from the environment', () => {
    process.env.ORCA_HEADLESS_BROWSER_RESIDENT_LIMIT = '7'
    process.env.ORCA_HEADLESS_BROWSER_PARK_IDLE_MS = '1234'
    process.env.ORCA_HEADLESS_BROWSER_PARK_GRACE_MS = '56'
    expect(readOffscreenBrowserRetentionBudget()).toEqual({
      limit: 7,
      idleMs: 1234,
      graceMs: 56
    })
  })

  it('ignores a malformed knob rather than disabling the budget', () => {
    process.env.ORCA_HEADLESS_BROWSER_RESIDENT_LIMIT = 'lots'
    expect(readOffscreenBrowserRetentionBudget().limit).toBe(OFFSCREEN_BROWSER_RESIDENT_LIMIT)
  })

  it('reads scientific notation whole, not truncated to its mantissa', () => {
    // Why: parseInt('1e9') is 1 — an operator following the docs' "set the
    // idle window very high" advice would get a 1ms window instead.
    process.env.ORCA_HEADLESS_BROWSER_PARK_IDLE_MS = '1e9'
    expect(readOffscreenBrowserRetentionBudget().idleMs).toBe(1_000_000_000)
  })

  it('falls back on trailing garbage instead of truncating it', () => {
    process.env.ORCA_HEADLESS_BROWSER_PARK_IDLE_MS = '1234abc'
    expect(readOffscreenBrowserRetentionBudget().idleMs).toBe(OFFSCREEN_BROWSER_IDLE_PARK_MS)
  })

  it('treats blank as unset, not as a zero window', () => {
    // Why: Number('') and Number('   ') are 0 — a blank knob must not silently
    // configure instant parking.
    process.env.ORCA_HEADLESS_BROWSER_PARK_IDLE_MS = '   '
    expect(readOffscreenBrowserRetentionBudget().idleMs).toBe(OFFSCREEN_BROWSER_IDLE_PARK_MS)
  })
})

describe('nextOffscreenBrowserReclaimCheckAt', () => {
  it('arms nothing when there is nothing resident', () => {
    expect(nextCheck([])).toBeNull()
  })

  it('waits out the idle window for a page within the limit', () => {
    expect(nextCheck([used('a', 10_000)])).toBe(NOW - 10_000 + BUDGET.idleMs)
  })

  it('waits only out the grace floor for a page beyond the limit', () => {
    const candidates = [used('a', 1_000), used('b', 2_000), used('over', 3_000)]
    expect(nextCheck(candidates)).toBe(NOW - 3_000 + BUDGET.graceMs)
  })

  it('takes the earliest deadline across pages', () => {
    const candidates = [used('a', 1_000), used('b', 59_000)]
    expect(nextCheck(candidates)).toBe(NOW - 59_000 + BUDGET.idleMs)
  })

  it('re-asks on a bounded cadence for a pinned page whose release it cannot observe', () => {
    expect(nextCheck([used('a', 90_000)], ['a'])).toBe(NOW + OFFSCREEN_BROWSER_PINNED_RECHECK_MS)
  })

  it('arms nothing when a page can never age out', () => {
    // A single page within a limit that no clock rule can evict.
    expect(
      nextCheck([used('a', 10)], [], NOW, {
        ...BUDGET,
        idleMs: Number.POSITIVE_INFINITY
      })
    ).toBeNull()
  })

  it('returns a past deadline when a page is already evictable', () => {
    expect(nextCheck([used('a', 90_000)])).toBeLessThanOrEqual(NOW)
  })
})

describe('the deadline never sleeps through an eviction', () => {
  // Why: the timer replaced a fixed sweep, so a deadline that lands after a page
  // becomes evictable would silently leak exactly the renderers this reclaims.
  // Fuzzed deterministically: no state may become evictable before its deadline.
  it('holds across randomised resident sets', () => {
    let seed = 42
    const random = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % bound
    }
    for (let trial = 0; trial < 500; trial++) {
      const size = random(6)
      const candidates: BrowserRetentionCandidate[] = []
      for (let index = 0; index < size; index++) {
        // Why the mix: uniform ages almost never land inside the grace floor,
        // which is exactly the boundary a wrong deadline overshoots.
        const msAgo = random(2) === 0 ? random(2 * BUDGET.graceMs) : random(200_000)
        candidates.push(used(`p${index}`, msAgo))
      }
      candidates.sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
      const pinned = candidates.filter(() => random(4) === 0).map((candidate) => candidate.id)
      const isPinned = (id: string): boolean => pinned.includes(id)
      const evictableNow = selectBrowserRetentionEvictions({
        candidates,
        isPinned,
        now: NOW,
        budget: BUDGET
      })
      if (evictableNow.length > 0) {
        continue
      }
      const deadline = nextCheck(candidates, pinned)
      const horizon = deadline === null ? NOW + 10 * BUDGET.idleMs : deadline
      for (let at = NOW; at < horizon; at += Math.max(1, Math.floor((horizon - NOW) / 20))) {
        expect(
          selectBrowserRetentionEvictions({
            candidates,
            isPinned,
            now: at,
            budget: BUDGET
          })
        ).toEqual([])
      }
    }
  })
})
