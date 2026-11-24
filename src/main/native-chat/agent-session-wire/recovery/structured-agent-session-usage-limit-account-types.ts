import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

export type UsageLimitAccountUsage = {
  key: string
  read: () => ProviderRateLimits | null
  refresh: (notWithinMs?: number) => boolean
}

export type UsageLimitAccountScope = {
  scope: string
  account?: UsageLimitAccountUsage
  bootstrap?: (notWithinMs?: number) => boolean
}

export type UsageLimitAccountVerdict = {
  resetsAt: number
  unknownReset: boolean
  awaitingReading: boolean
  awaitingRoom: boolean
  /** A room reading, rather than a reset time, made this cut eligible. */
  releasedByRoom: boolean
}
