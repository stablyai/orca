export const BROWSER_HOST_WEBVIEW_CAPABILITY = 'webview'

type BrowserHostCapabilityLease = Readonly<{
  browserHostClientId: string
  hostCapabilities: readonly string[]
}>
type BrowserHostLeaseStateView<T extends BrowserHostCapabilityLease> = Readonly<{ lease: T }>

/** Names every capable host so a caller that must pick one can choose among them. */
export class BrowserHostAmbiguousError extends Error {
  constructor(readonly browserHostClientIds: readonly string[]) {
    super('browser_host_ambiguous')
  }
}

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
  const capable = [...leasesByClientId.values()]
    .map((state) => state.lease)
    .filter((lease) => hasCapabilities(lease, requiredCapabilities))
  if (capable.length > 1) {
    throw new BrowserHostAmbiguousError(capable.map((lease) => lease.browserHostClientId))
  }
  const selected = capable[0]
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
