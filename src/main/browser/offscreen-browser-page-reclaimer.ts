import {
  selectBrowserRetentionEvictions,
  isBrowserRetentionCandidateInGrace,
  type BrowserRetentionBudget,
  type BrowserRetentionCandidate
} from '../../shared/browser-retention-budget'
import type {
  OffscreenBrowserOpenPages,
  OffscreenBrowserPage
} from './offscreen-browser-open-pages'
import { nextOffscreenBrowserReclaimCheckAt } from './offscreen-browser-page-reclaim'

// Why (STA-4341): the trigger half of the headless page budget — it decides
// *when* to ask, while the shared browser retention budget decides *what* to
// evict. The desktop guest budget gets its trigger for free from a UI
// visibility change; a headless host has no such event, so this arms a one-shot
// timer for the moment its own answer could next change. There is deliberately
// no recurring sweep: a host doing nothing holds no timer at all.

/** Node's setTimeout ceiling; longer delays are clamped by Node to 1ms. */
const MAX_RECLAIM_TIMER_DELAY_MS = 2_147_483_647

export type OffscreenBrowserReclaimerDeps = {
  pages: OffscreenBrowserOpenPages
  budget: BrowserRetentionBudget
  /** A teardown this backend already started for the page. */
  isReleasing: (browserPageId: string) => boolean
  /** A wake still rebuilding the page's renderer. */
  isWaking: (browserPageId: string) => boolean
  /** A certificate challenge the page is blocked on. */
  hasCertificateChallenge: (browserPageId: string) => boolean
  /** A download the page is still writing. */
  hasActiveDownload: (browserPageId: string) => boolean
  /** A client streaming the page, or a command in flight against it. */
  isHostPinned: (browserPageId: string) => boolean
  park: (browserPageId: string) => Promise<void>
  now: () => number
}

export class OffscreenBrowserPageReclaimer {
  private timer: NodeJS.Timeout | null = null
  private sweepInFlight: Promise<unknown> | null = null
  /** Set when a sweep parked nothing — see reschedule(). */
  private backoffUntil = 0
  /** stop() is terminal: nothing may arm a timer after it. */
  private stopped = false

  constructor(private readonly deps: OffscreenBrowserReclaimerDeps) {}

  /** Park every page the budget no longer wants resident, then re-arm. */
  async sweep(): Promise<string[]> {
    const parked = await this.parkOverBudgetPages()
    this.reschedule()
    return parked
  }

  /**
   * Re-arm the timer for the next moment the answer could change.
   *
   * Call after anything that moves a page's activity, residency or pin state.
   * Recomputing from live state means a missed call can only delay a park,
   * never schedule a wrong one, and an all-parked host arms nothing.
   */
  reschedule(): void {
    this.clearTimer()
    // Why: a sweep re-arms itself when it settles. Arming now would race it
    // against state the in-flight parks are still changing. And after stop()
    // nothing may arm at all — a still-settling sweep or a 'destroyed' handler
    // firing inside destroyAll would otherwise schedule a check post-shutdown.
    if (this.stopped || this.sweepInFlight) {
      return
    }
    const now = this.deps.now()
    const at = nextOffscreenBrowserReclaimCheckAt({
      candidates: this.candidates(),
      isPinned: (browserPageId) => this.isPinnedById(browserPageId),
      now,
      budget: this.deps.budget
    })
    if (at === null) {
      return
    }
    // Why the floor: a deadline in the past that the last sweep could not act on
    // would re-arm at 0ms, and a timer that re-arms itself instantly is a pegged
    // CPU on an otherwise idle server. Why the ceiling: Node clamps a setTimeout
    // beyond 2^31-1ms to 1ms — the same spin, reachable by configuring the idle
    // window past ~24.8 days. Re-checking at the horizon is harmless.
    const delay = Math.min(
      Math.max(0, at - now, this.backoffUntil - now),
      MAX_RECLAIM_TIMER_DELAY_MS
    )
    this.timer = setTimeout(() => {
      this.timer = null
      this.runSweep()
    }, delay)
    // Why: reclamation must never be the reason the process stays alive.
    this.timer.unref?.()
  }

  /** Whether a check is currently armed. Exposed so the owner can assert it. */
  get isScheduled(): boolean {
    return this.timer !== null
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.sweepInFlight = null
    this.backoffUntil = 0
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private runSweep(): void {
    if (this.sweepInFlight) {
      return
    }
    const sweep = this.sweep().catch(() => {
      // A failed park is retried on the next check.
    })
    this.sweepInFlight = sweep
    void sweep.finally(() => {
      if (this.sweepInFlight === sweep) {
        this.sweepInFlight = null
        this.reschedule()
      }
    })
  }

  private async parkOverBudgetPages(): Promise<string[]> {
    const residentBefore = this.deps.pages.resident().length
    const doomed = selectBrowserRetentionEvictions({
      candidates: this.candidates(),
      isPinned: (browserPageId) => this.isPinnedById(browserPageId),
      now: this.deps.now(),
      budget: this.deps.budget
    })
    const parked: string[] = []
    // Why reversed: the selector ranks most-recently-used first, so this parks
    // the coldest page first — the one least likely to be woken mid-teardown.
    for (const browserPageId of doomed.toReversed()) {
      // Why: parking awaits the helper session's teardown, so a page later in
      // this list can be woken and driven while an earlier one is still being
      // torn down. The selection is a proposal, not a licence — re-check each
      // page against live state before destroying its renderer.
      if (!this.isSafeToReclaim(browserPageId)) {
        continue
      }
      try {
        await this.deps.park(browserPageId)
      } catch {
        // Why: a park that throws must still reach the backoff below. Letting
        // it propagate skips the assignment, and the next reschedule would see
        // a deadline in the past with a zero backoff — an instant re-sweep
        // that fails the same way, forever. Retried on the next check instead.
        continue
      }
      parked.push(browserPageId)
    }
    // Why measured rather than reported: a sweep that frees nothing leaves the
    // deadline in the past, and re-arming at 0ms would spin the timer flat out.
    // park() cannot be trusted to say so — it no-ops for a window that is
    // already gone — so residency is the only honest signal of progress.
    const madeProgress = this.deps.pages.resident().length < residentBefore
    this.backoffUntil = madeProgress ? 0 : this.deps.now() + this.deps.budget.graceMs
    return parked
  }

  /** Resident pages the budget can rank, most recently used first. */
  private candidates(): BrowserRetentionCandidate[] {
    return this.deps.pages
      .resident()
      .filter((page) => !this.deps.isReleasing(page.browserPageId))
      .sort(
        (left, right) =>
          right.lastActivityAt - left.lastActivityAt ||
          left.browserPageId.localeCompare(right.browserPageId)
      )
      .map((page) => ({
        id: page.browserPageId,
        lastActivityAt: page.lastActivityAt
      }))
  }

  // Why: a page is off limits while anything depends on its renderer — a client
  // streaming it, a command in flight, its first navigation still committing, a
  // wake still rebuilding it, a certificate decision it is blocked on, or a
  // download it is still writing. `loading` is bounded by the load helper's own
  // timeout, so it cannot hold a renderer forever; a navigation still pending
  // past that timeout is deliberately parkable, and waking retries the address.
  private isPinned(page: OffscreenBrowserPage): boolean {
    return (
      page.loading ||
      this.deps.isWaking(page.browserPageId) ||
      // Why: a challenge id dies with the renderer, so parking would discard
      // both the warning and the ability to approve it.
      this.deps.hasCertificateChallenge(page.browserPageId) ||
      // Why: releasing a renderer unregisters its guest, and that cancels the
      // page's in-flight downloads. Mirrors the desktop guest budget's veto
      // (browser-guest-worktree-retention.ts).
      this.deps.hasActiveDownload(page.browserPageId) ||
      this.deps.isHostPinned(page.browserPageId)
    )
  }

  private isPinnedById(browserPageId: string): boolean {
    const page = this.deps.pages.get(browserPageId)
    return page ? this.isPinned(page) : false
  }

  private isSafeToReclaim(browserPageId: string): boolean {
    const page = this.deps.pages.get(browserPageId)
    if (!page || this.deps.isReleasing(browserPageId)) {
      return false
    }
    if (this.isPinned(page)) {
      return false
    }
    return !isBrowserRetentionCandidateInGrace(
      { id: browserPageId, lastActivityAt: page.lastActivityAt },
      this.deps.now(),
      this.deps.budget
    )
  }
}
