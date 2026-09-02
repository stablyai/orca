import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import { requireBrowserHostLeaseState } from './browser-host-lease-state-resolution'

export function requireBrowserClientPageConnection(
  input: {
    browserPageId: string
    placement: RuntimeBrowserClientPlacement
    pairedDeviceId: string
    connectionId: string
  },
  dependencies: {
    authorityRuntimeId: string
    authorityEpoch: string
    leasesByClientId: Map<string, BrowserHostLeaseState>
    pagePlacements: BrowserHostPagePlacementRegistry
  }
): RuntimeBrowserClientPlacement {
  const state = requireBrowserHostLeaseState(
    dependencies.authorityEpoch,
    dependencies.leasesByClientId,
    {
      authorityEpoch: dependencies.authorityEpoch,
      browserHostClientId: input.placement.browserHostClientId,
      browserHostGeneration: input.placement.browserHostGeneration,
      pairedDeviceId: input.pairedDeviceId
    }
  )
  if (state.lease.connectionId !== input.connectionId) {
    throw new Error('browser_host_lease_stale')
  }
  return dependencies.pagePlacements.requireClientPage({
    authorityRuntimeId: dependencies.authorityRuntimeId,
    authorityEpoch: dependencies.authorityEpoch,
    browserPageId: input.browserPageId,
    browserHostClientId: input.placement.browserHostClientId,
    browserHostGeneration: input.placement.browserHostGeneration,
    pageHostGeneration: input.placement.pageHostGeneration
  })
}
