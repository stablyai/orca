import {
  chooseDynamicAccount,
  countDynamicAccountPick,
  isDynamicAccountReadingFresh,
  type DynamicAccountCandidate,
  type DynamicAccountPicks
} from '../../../shared/dynamic-account-choice'
import {
  dynamicAccountMarginPercent,
  type DynamicAccountLaunchSettings
} from '../../../shared/dynamic-account-launch-settings'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'

// A slow usage refresh delays a launch by at most this long; the pick then uses cached readings.
const DYNAMIC_ACCOUNT_REFRESH_WAIT_MS = 1_500
const SELECTED_READING_REFRESH_MS = 5 * 60_000

/** One provider's per-launch account pick: another account than the selection, or null to keep it. */
export class DynamicAccountLaunchPick {
  private readonly picks: DynamicAccountPicks = new Map()

  refresh(
    readings: Pick<RateLimitService, 'requestUsageReading'>,
    provider: 'claude' | 'codex',
    fetchInactiveReadings: () => Promise<void>
  ): Promise<void> {
    // The selection is polled only while a meter watches; a stale selection reading pauses the pick.
    readings.requestUsageReading(provider, { notWithinMs: SELECTED_READING_REFRESH_MS })
    return withTimeout(fetchInactiveReadings(), DYNAMIC_ACCOUNT_REFRESH_WAIT_MS, undefined)
  }

  /** `candidates` lists the selection first; each pick counts toward the burst guard. */
  pick(
    settings: DynamicAccountLaunchSettings,
    candidates: () => [DynamicAccountCandidate, ...DynamicAccountCandidate[]]
  ): string | null {
    try {
      const [selected, ...others] = candidates()
      const now = Date.now()
      // An unread selection may already be the best account; keep it rather than guess.
      if (!isDynamicAccountReadingFresh(selected.rateLimits, now)) {
        return null
      }
      const pick = chooseDynamicAccount(
        [selected, ...others],
        dynamicAccountMarginPercent(settings),
        now,
        this.picks
      )
      if (pick) {
        countDynamicAccountPick(this.picks, pick)
      }
      return pick && pick !== selected ? pick.accountId : null
    } catch (error) {
      console.warn('[dynamic-account-launch] Keeping the selected account:', error)
      return null
    }
  }
}
