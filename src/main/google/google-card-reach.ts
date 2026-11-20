import { getBrowserHostLeaseRegistry } from '../runtime/browser-host/leases/browser-host-lease-registry-instance'
import { getBrowserHostRequestRegistry } from '../runtime/browser-host/leases/browser-host-request-registry'
import { canPlacePairedPage } from '../runtime/browser/client-pages/browser-client-page-opening'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

// Paired windows connected now that said they draw Google setup cards; a released desktop without
// them could host the sign-in page but would show its owner nothing to press.
let cardRenderers = 0

export function registerGoogleCardRenderer(): () => void {
  cardRenderers += 1
  let registered = true
  return () => {
    if (registered) {
      registered = false
      cardRenderers -= 1
    }
  }
}

/** No owner window can answer a Google Connect card: no window here, and no paired desktop that
 *  both draws the card and could open Google's sign-in page for this host. */
export function noWindowAnswersGoogleCards(runtime: OrcaRuntimeService): boolean {
  return (
    runtime.servesWithoutWindow() &&
    !(
      cardRenderers > 0 &&
      canPlacePairedPage({
        getBrowserHostLeaseRegistry: () => getBrowserHostLeaseRegistry(runtime),
        getBrowserHostRequestRegistry: () => getBrowserHostRequestRegistry(runtime)
      })
    )
  )
}
