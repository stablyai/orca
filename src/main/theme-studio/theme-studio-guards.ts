import {
  THEME_STUDIO_ERROR_CODES,
  ThemeStudioError
} from '../../shared/theme-studio/theme-studio-errors'

// Why these rates: an agent's normal loop is a few calls a second; a runaway loop repaints the
// whole window, so it waits instead.
const BUCKET_SIZE = 30
const REFILL_PER_SECOND = 3
const MAX_CALLERS = 64

/** Per-caller token buckets for theme changes. */
export class ThemeStudioRateLimit {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Spends one change for `caller`, or throws `rate_limited` with how long to wait. */
  take(caller: string): void {
    const now = this.now()
    const bucket = this.buckets.get(caller) ?? { tokens: BUCKET_SIZE, at: now }
    const tokens = Math.min(
      BUCKET_SIZE,
      bucket.tokens + ((now - bucket.at) / 1000) * REFILL_PER_SECOND
    )
    if (tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - tokens) / REFILL_PER_SECOND) * 1000)
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
    this.buckets.delete(caller)
    this.buckets.set(caller, { tokens: tokens - 1, at: now })
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
