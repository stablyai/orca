import type { AntigravityStatusLineReading } from '../../../shared/agent-usage/rate-limits/antigravity-statusline-quota'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'

export type AntigravityLiveUsageResolver = {
  isEnabled: () => boolean
  /** Matches a saved agy account by email without reading agy's own login. */
  accountIdForEmail: (email: string) => Promise<string | null>
}

type AntigravityLiveUsageHost = {
  current: () => ProviderRateLimits | null
  publish: (next: ProviderRateLimits | null) => void
}

function sameReading(previous: ProviderRateLimits, next: ProviderRateLimits): boolean {
  const key = (limits: ProviderRateLimits): string =>
    JSON.stringify([
      limits.session,
      limits.weekly,
      limits.buckets ?? [],
      limits.usageMetadata?.account
    ])
  return key(previous) === key(next)
}

// agy reports quota only while it runs in an Orca terminal; nothing here ever fetches or polls.
export class AntigravityLiveUsage {
  private resolver: AntigravityLiveUsageResolver | null = null
  private lastReceivedAt = 0

  constructor(private readonly host: AntigravityLiveUsageHost) {}

  setResolver(resolver: AntigravityLiveUsageResolver): void {
    this.resolver = resolver
  }

  async ingest(reading: AntigravityStatusLineReading): Promise<void> {
    const receivedAt = reading.limits.updatedAt
    if (!this.resolver?.isEnabled() || receivedAt < this.lastReceivedAt) {
      return
    }
    this.lastReceivedAt = receivedAt
    const accountId = reading.email
      ? await this.resolver.accountIdForEmail(reading.email).catch(() => null)
      : null
    // A newer post, or the setting turning off, may have landed while the account lookup ran.
    if (!this.resolver.isEnabled() || this.lastReceivedAt !== receivedAt) {
      return
    }
    const next: ProviderRateLimits = {
      ...reading.limits,
      usageMetadata: {
        ...reading.limits.usageMetadata,
        account: { id: accountId, email: reading.email }
      }
    }
    const previous = this.host.current()
    // Unchanged values keep the time Orca first received them.
    if (previous && sameReading(previous, next)) {
      return
    }
    this.host.publish(next)
  }

  clear(): void {
    this.lastReceivedAt = 0
    if (this.host.current()) {
      this.host.publish(null)
    }
  }
}
