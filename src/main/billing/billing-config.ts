import { cleanCloudServiceUrl } from '../../shared/cloud-service-url'
import type { OrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import type { BillingEndpoints } from './billing-client'

/**
 * Billing is opt-in per build until the service is deployed: no production default yet, so
 * packaged builds report 'unconfigured' and the menu item stays hidden behind its capability flag.
 */
export function getBillingEndpoints(
  authConfig: Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>,
  env: NodeJS.ProcessEnv,
  packaged: boolean
): BillingEndpoints | null {
  const allowLoopbackHttp = !packaged
  const billingApiUrl = cleanCloudServiceUrl(env.ORCA_BILLING_API_URL, allowLoopbackHttp)
  if (!billingApiUrl) {
    return null
  }
  const billingTokenEndpoint =
    cleanCloudServiceUrl(env.ORCA_CLOUD_BILLING_TOKEN_URL, allowLoopbackHttp) ??
    new URL('/v1/desktop/auth/billing-token', `${authConfig.apiBaseUrl}/`).toString()
  return { billingApiUrl, billingTokenEndpoint }
}
