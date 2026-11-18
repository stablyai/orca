import type { UsageCall } from '../../shared/backend/backend-service-contract'

type HostUsageAnalytics = (call: UsageCall) => Promise<unknown>

let hostUsageAnalytics: HostUsageAnalytics | null = null

/** Each host process has one usage service: the desktop's backend process or orcad's own. */
export function provideHostUsageAnalytics(analytics: HostUsageAnalytics): void {
  hostUsageAnalytics = analytics
}

export function invokeHostUsageAnalytics(call: UsageCall): Promise<unknown> {
  if (!hostUsageAnalytics) {
    return Promise.reject(new Error('Usage analytics are not available on this host.'))
  }
  return hostUsageAnalytics(call)
}
