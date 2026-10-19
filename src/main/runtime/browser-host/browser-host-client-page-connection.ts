import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'
import {
  sameRuntimeBrowserPlacement,
  type RuntimeBrowserClientPlacement
} from '../../../shared/runtime-browser-placement'
import { requireBrowserHostLeaseState } from './browser-host-lease-state-resolution'
import { pendingBrowserHostProfileSwitches } from './browser-host-client-profile-switch'

export function requireBrowserClientPageConnection(
  input: {
    browserPageId: string
    placement: RuntimeBrowserClientPlacement
    pairedDeviceId: string
    connectionId: string
    /** File transfers only: a staged profile-switch guest downloads before its generation commits. */
    admitPendingProfileSwitch?: boolean
  },
  dependencies: {
    authorityRuntimeId: string
    authorityEpoch: string
    leasesByClientId: Map<string, BrowserHostLeaseState>
    pagePlacements: BrowserHostPagePlacementRegistry
  }
): RuntimeBrowserClientPlacement {
  const pending = input.admitPendingProfileSwitch
    ? pendingBrowserHostProfileSwitches(dependencies.pagePlacements).get(input.browserPageId)
    : undefined
  const current = dependencies.pagePlacements.getPlacement(input.browserPageId)
  if (
    pending &&
    current?.kind === 'client' &&
    sameRuntimeBrowserPlacement(pending, input.placement)
  ) {
    // Why: the replacement downloads while loading, before the host commits its generation.
    requireBrowserClientPageConnection(
      { ...input, placement: current, admitPendingProfileSwitch: false },
      dependencies
    )
    return pending
  }
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
