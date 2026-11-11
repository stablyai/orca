import type {
  AntigravityAccountUsage,
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../shared/rate-limit-types'

export type AntigravityUsageLogin = {
  /** Stable across agy token refreshes; changes when a different login is stored. */
  key: string
  accountId: string | null
  email: string | null
}

export type AntigravityUsageReadStart = {
  login: AntigravityUsageLogin | null
  accounts: AntigravityAccountUsage[]
}

export type AntigravityUsageReadFinish =
  | { switched: true }
  | {
      switched: false
      account: { id: string | null; email: string | null }
      accounts: AntigravityAccountUsage[]
    }

/** Binds agy readings to the saved account that was signed in for the whole read. */
export type AntigravityAccountUsageRecorder = {
  /** Null when no account is saved, so unsaved setups never read native credentials. */
  begin(target: RateLimitRuntimeTarget): Promise<AntigravityUsageReadStart | null>
  finish(
    target: RateLimitRuntimeTarget,
    login: AntigravityUsageLogin,
    limits: ProviderRateLimits
  ): Promise<AntigravityUsageReadFinish>
}

// The Antigravity meter reads the host's agy; a per-runtime meter passes its own target.
export const ANTIGRAVITY_USAGE_HOST_TARGET: RateLimitRuntimeTarget = {
  runtime: 'host',
  wslDistro: null
}

export function isSameRuntimeTarget(
  left: RateLimitRuntimeTarget,
  right: RateLimitRuntimeTarget
): boolean {
  return left.runtime === right.runtime && (left.wslDistro ?? null) === (right.wslDistro ?? null)
}
