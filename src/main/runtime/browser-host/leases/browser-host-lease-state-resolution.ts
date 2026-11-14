import type { BrowserHostLeaseIdentity, BrowserHostLeaseState } from './browser-host-lease-records'

export function requireBrowserHostLeaseState(
  authorityEpoch: string,
  leasesByClientId: Map<string, BrowserHostLeaseState>,
  identity: BrowserHostLeaseIdentity
): BrowserHostLeaseState {
  if (identity.authorityEpoch !== authorityEpoch) {
    throw new Error('browser_host_lease_stale')
  }
  const state = leasesByClientId.get(identity.browserHostClientId)
  if (!state) {
    throw new Error('browser_host_lease_required')
  }
  if (
    state.lease.browserHostGeneration !== identity.browserHostGeneration ||
    state.lease.pairedDeviceId !== identity.pairedDeviceId
  ) {
    throw new Error('browser_host_lease_stale')
  }
  if (state.status !== 'active') {
    throw new Error('browser_host_lease_reconnecting')
  }
  return state
}
