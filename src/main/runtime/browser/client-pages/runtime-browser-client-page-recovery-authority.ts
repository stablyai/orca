import type { RuntimeBrowserClientPage } from './runtime-browser-page-registry'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostLeaseAuthority
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { isRestoredClientHostedBrowserPlacement } from './client-hosted-browser-page-persistence'

/** Retained pages match client identity across generations. Restored pages match paired device because client ids rotate per process.
 * Device matching prevents another or revoked/re-paired device from inheriting tabs; unmatched rows stay host-absent and closeable. */
export function isRecoverableByLease(
  page: RuntimeBrowserClientPage,
  lease: BrowserClientHostLeaseAuthority & { pairedDeviceId: string }
): boolean {
  if (isRestoredClientHostedBrowserPlacement(page.placement)) {
    return page.pairedDeviceId === lease.pairedDeviceId
  }
  return (
    page.placement.browserHostClientId === lease.browserHostClientId &&
    page.placement.browserHostGeneration <= lease.browserHostGeneration
  )
}

export function isActiveExactPage(
  page: RuntimeBrowserClientPage,
  inventory: BrowserClientHostedPageInventory | undefined,
  lease: BrowserClientHostLeaseAuthority
): boolean {
  return Boolean(
    inventory?.state === 'active' &&
    inventory.authorityRuntimeId === lease.authorityRuntimeId &&
    inventory.authorityEpoch === lease.authorityEpoch &&
    inventory.browserHostClientId === page.placement.browserHostClientId &&
    inventory.browserHostGeneration === page.placement.browserHostGeneration &&
    inventory.pageHostGeneration === page.placement.pageHostGeneration &&
    inventory.browserProfileId === page.browserProfileId &&
    inventory.executionHostKey === page.executionHostKey
  )
}

export function assertInventoryAuthority(
  page: RuntimeBrowserClientPage,
  inventory: BrowserClientHostedPageInventory,
  lease: BrowserClientHostLeaseAuthority
): void {
  if (
    inventory.authorityRuntimeId !== lease.authorityRuntimeId ||
    inventory.authorityEpoch !== lease.authorityEpoch ||
    inventory.browserHostClientId !== page.placement.browserHostClientId ||
    inventory.browserHostGeneration !== page.placement.browserHostGeneration ||
    inventory.pageHostGeneration !== page.placement.pageHostGeneration
  ) {
    throw new Error('browser_client_page_reconciliation_authority_stale')
  }
}
