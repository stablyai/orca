export const BROWSER_HOST_WEBVIEW_CAPABILITY = 'webview'

type BrowserHostCapabilityLease = Readonly<{ hostCapabilities: readonly string[] }>
type BrowserHostLeaseStateView<T extends BrowserHostCapabilityLease> = Readonly<{ lease: T }>

export function selectBrowserHostLease<T extends BrowserHostCapabilityLease>(
  leasesByClientId: ReadonlyMap<string, BrowserHostLeaseStateView<T>>,
  browserHostClientId?: string,
  requiredCapabilities: readonly string[] = []
): T {
  if (browserHostClientId) {
    const exact = leasesByClientId.get(browserHostClientId)
    if (!exact) {
      throw new Error('browser_host_unavailable')
    }
    if (!hasCapabilities(exact.lease, requiredCapabilities)) {
      throw new Error('browser_host_capability_unavailable')
    }
    return exact.lease
  }
  let selected: T | undefined
  for (const state of leasesByClientId.values()) {
    if (!hasCapabilities(state.lease, requiredCapabilities)) {
      continue
    }
    if (selected) {
      throw new Error('browser_host_ambiguous')
    }
    selected = state.lease
  }
  if (!selected) {
    throw new Error('browser_host_unavailable')
  }
  return selected
}

function hasCapabilities(
  lease: BrowserHostCapabilityLease,
  requiredCapabilities: readonly string[]
): boolean {
  return requiredCapabilities.every((capability) => lease.hostCapabilities.includes(capability))
}
