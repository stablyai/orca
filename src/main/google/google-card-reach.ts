import { getBrowserHostLeaseRegistry } from '../runtime/browser-host/leases/browser-host-lease-registry-instance'
import { getBrowserHostRequestRegistry } from '../runtime/browser-host/leases/browser-host-request-registry'
import { canPlacePairedPage } from '../runtime/browser/client-pages/browser-client-page-opening'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** No owner window can answer a Google Connect card: no window here, and no paired desktop that
 *  could open Google's sign-in page for this host. */
export function noWindowAnswersGoogleCards(runtime: OrcaRuntimeService): boolean {
  return (
    runtime.servesWithoutWindow() &&
    !canPlacePairedPage({
      getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(runtime),
      getBrowserHostRequestRegistry: () => getBrowserHostRequestRegistry(runtime)
    })
  )
}
