import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'

// Why these rates: an agent's normal loop is a few calls a second; a runaway loop repaints the
// whole window, so it waits instead.
const CALLER_RATE = { size: 30, perSecond: 3 }
// Why a shared bucket too: callers can name any terminal, and every change repaints one window.
const ALL_CALLERS = '\u0000all'
const ALL_RATE = { size: 60, perSecond: 6 }
const MAX_CALLERS = 64

type Bucket = { tokens: number; at: number }

/** Token buckets for theme changes: one per caller and one for everyone together. */
export class ThemeStudioRateLimit {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly now: () => number = Date.now) {}

  private refill(key: string, rate: { size: number; perSecond: number }, now: number): number {
    const bucket = this.buckets.get(key) ?? { tokens: rate.size, at: now }
    return Math.min(rate.size, bucket.tokens + ((now - bucket.at) / 1000) * rate.perSecond)
  }

  /** Spends one change for `caller`, or throws `rate_limited` with how long to wait. */
  take(caller: string): void {
    const now = this.now()
    const own = this.refill(caller, CALLER_RATE, now)
    const all = this.refill(ALL_CALLERS, ALL_RATE, now)
    const waits = [
      own < 1 ? ((1 - own) / CALLER_RATE.perSecond) * 1000 : 0,
      all < 1 ? ((1 - all) / ALL_RATE.perSecond) * 1000 : 0
    ]
    if (Math.max(...waits) > 0) {
      const retryAfterMs = Math.ceil(Math.max(...waits))
      throw new ThemeStudioError(
        THEME_STUDIO_ERROR_CODES.rateLimited,
        'Too many theme changes at once.',
        {
          retryAfterMs,
          nextSteps: [
            `Wait ${retryAfterMs} ms, and batch several tokens into one \`orca theme set\` or \`--patch-stdin\`.`
          ]
        }
      )
    }
    // Why delete then set: a fresh insert keeps the busiest keys out of the eviction below.
    this.buckets.delete(ALL_CALLERS)
    this.buckets.set(ALL_CALLERS, { tokens: all - 1, at: now })
    this.buckets.delete(caller)
    this.buckets.set(caller, { tokens: own - 1, at: now })
    // Why evict the oldest: callers come and go with each terminal; the map must stay small.
    if (this.buckets.size > MAX_CALLERS) {
      const oldest = this.buckets.keys().next().value
      if (oldest !== undefined) {
        this.buckets.delete(oldest)
      }
    }
  }
}

export function assertAgentEditsAllowed(allowed: boolean): void {
  if (!allowed) {
    throw new ThemeStudioError(
      THEME_STUDIO_ERROR_CODES.disabled,
      'Agent theme edits are turned off in this Orca.',
      {
        nextSteps: ['Ask the user to turn on "Let agents edit the theme" in Settings → Appearance.']
      }
    )
  }
}

export function assertRevision(expected: number | undefined, current: number): void {
  if (expected !== undefined && expected !== current) {
    throw new ThemeStudioError(
      THEME_STUDIO_ERROR_CODES.conflict,
      `The draft is at revision ${current}, not ${expected}.`,
      {
        revision: current,
        nextSteps: [
          `Run \`orca theme show --json\`, then repeat the change with --if-revision ${current}.`
        ]
      }
    )
  }
}

export function draftEndedByUser(reason: string): ThemeStudioError {
  return new ThemeStudioError(
    THEME_STUDIO_ERROR_CODES.endedByUser,
    `The user ended the theme draft (${reason}).`,
    {
      reason,
      nextSteps: [
        'Ask the user before starting another draft; `orca theme edit` starts one when they agree.'
      ]
    }
  )
}
