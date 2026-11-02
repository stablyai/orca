import { z } from 'zod'
import {
  MOBILE_WEB_BUNDLE_MAX_GRANTED_ROUTE_GRANTS,
  MobileWebBundleGrantNameSchema
} from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import { BRIDGE_MAX_PAGE_ROUTES, BRIDGE_MAX_ROUTE_PATHNAME_CHARS } from './bridge-caps'

// Carry each route’s manifest grants, using the manifest grammar. Pattern membership alone cannot authorize a local hop under the opener’s narrower grants.
export const BridgePageRouteGrantsSchema = z
  .array(
    z
      .object({
        pathname: z.string().min(1).max(BRIDGE_MAX_ROUTE_PATHNAME_CHARS),
        grants: z
          .array(MobileWebBundleGrantNameSchema)
          .max(MOBILE_WEB_BUNDLE_MAX_GRANTED_ROUTE_GRANTS)
      })
      .strict()
  )
  .max(BRIDGE_MAX_PAGE_ROUTES)

export type BridgePageRouteGrants = z.infer<typeof BridgePageRouteGrantsSchema>
