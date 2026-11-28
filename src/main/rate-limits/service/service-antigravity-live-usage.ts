import type { AntigravityStatusLineReading } from '../../../shared/agent-usage/rate-limits/antigravity-statusline-quota'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'

type AntigravityLiveUsageHost = {
  current: () => ProviderRateLimits | null
  publish: (next: ProviderRateLimits | null) => void
}

function windowsKey(limits: ProviderRateLimits): string {
  return JSON.stringify([limits.session, limits.weekly, limits.buckets ?? []])
}

// agy reports quota only while it runs in an Orca terminal; nothing here ever fetches, polls or
// reads credentials. Ingest is synchronous, so the last post to arrive is the newest.
export class AntigravityLiveUsage {
  private isEnabled: (() => boolean) | null = null

  constructor(private readonly host: AntigravityLiveUsageHost) {}

  setEnabledResolver(isEnabled: () => boolean): void {
    this.isEnabled = isEnabled
  }

  ingest(reading: AntigravityStatusLineReading): void {
    if (!this.isEnabled?.()) {
      return
    }
    if (!reading.buckets?.length) {
      this.clear()
      return
    }
    const previous = this.host.current()
    // Unchanged windows keep the time Orca first received them.
    if (previous && windowsKey(previous) === windowsKey(reading)) {
      return
    }
    this.host.publish(reading)
  }

  clear(): void {
    if (this.host.current()) {
      this.host.publish(null)
    }
  }
}
