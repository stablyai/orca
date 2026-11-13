// "Copy link" on billing buttons: the Stripe Checkout or Customer Portal URL the button would open,
// minted the same way (same account, same order, same setup-session fallback) but returned instead.
import type { OrcaBillingCheckoutArgs, OrcaBillingLinkResult } from '../../shared/orca-billing'
import { createCheckoutUrl, createPortalUrl } from './billing-client'
import { mintHosted } from './billing-service'
import { withSetupSessionFallback } from './billing-setup-session-fallback'

export function getOrcaBillingCheckoutLink(
  userDataPath: string,
  args: OrcaBillingCheckoutArgs
): Promise<OrcaBillingLinkResult> {
  return withSetupSessionFallback(args, (checkoutArgs) =>
    mintHosted(userDataPath, (token, endpoints) =>
      createCheckoutUrl(endpoints, token, checkoutArgs)
    )
  )
}

export function getOrcaBillingPortalLink(userDataPath: string): Promise<OrcaBillingLinkResult> {
  return mintHosted(userDataPath, (token, endpoints) => createPortalUrl(endpoints, token))
}
