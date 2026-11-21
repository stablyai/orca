import { RateLimitServiceResultPolicy } from './service-result-policy'
import { disabledUsageSnapshot } from './disabled-usage-snapshot'
import { fetchCursorRateLimits } from '../providers/cursor/cursor-fetcher'
import { readCursorAuthSession } from '../providers/cursor/cursor-auth'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'

export abstract class RateLimitServiceProviderAvailability extends RateLimitServiceResultPolicy {
  protected async usageProviderAllowed(
    provider: ProviderRateLimits['provider'],
    signal: AbortSignal,
    selectedTarget?: RateLimitRuntimeTarget,
    accountConfigured = false
  ): Promise<boolean> {
    const target =
      selectedTarget ??
      (provider === 'claude'
        ? this.claudeFetchTarget
        : provider === 'codex'
          ? this.codexFetchTarget
          : provider === 'kimi' || provider === 'antigravity'
            ? this.antigravityFetchTarget
            : undefined)
    return (
      !signal.aborted &&
      ((await this.usageProviderAvailabilityResolver?.(
        provider,
        signal,
        target,
        accountConfigured
      )) ??
        true)
    )
  }

  protected async fetchUsageIfAllowed(
    provider: ProviderRateLimits['provider'],
    signal: AbortSignal,
    fetch: () => Promise<ProviderRateLimits>,
    accountConfigured = false
  ): Promise<ProviderRateLimits> {
    return (await this.usageProviderAllowed(provider, signal, undefined, accountConfigured))
      ? fetch()
      : disabledUsageSnapshot(provider)
  }

  protected fetchCursorUsage(signal: AbortSignal): Promise<ProviderRateLimits> {
    return this.fetchUsageIfAllowed(
      'cursor',
      signal,
      async () => {
        const authReadResult = await readCursorAuthSession()
        this.cursorAuthConfigured = authReadResult.status === 'ok'
        return this.fetchUsageIfAllowed(
          'cursor',
          signal,
          () => fetchCursorRateLimits({ signal, authReadResult }),
          authReadResult.status === 'ok' && authReadResult.session.source === 'desktop'
        )
      },
      true
    )
  }
}
