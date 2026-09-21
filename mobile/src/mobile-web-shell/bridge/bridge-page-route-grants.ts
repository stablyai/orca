import { z } from 'zod'
import {
  MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS,
  MobileWebBundleGrantNameSchema
} from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import { BRIDGE_MAX_PAGE_ROUTES, BRIDGE_MAX_ROUTE_PATHNAME_CHARS } from './bridge-caps'

/**
 * What each page route declared, as it crosses in `init`.
 *
 * `pageRoutes` says which patterns this shell would render; it does not say what each costs. A page
 * that keeps a push local on the strength of the pattern alone runs the target under the opener's
 * grants, which is how the tasks page was reached from the sidebar without `native.clipboard.write`.
 *
 * Its own module rather than a block inside the envelope: the envelope is at its line ceiling, and
 * this is a self-contained shape the host validates before it builds a frame — so it is read in two
 * places and belongs in one.
 *
 * The grant grammar is the manifest's own, imported rather than restated, so a name the bundle
 * could not have declared cannot arrive here either.
 */
export const BridgePageRouteGrantsSchema = z
  .array(
    z
      .object({
        pathname: z.string().min(1).max(BRIDGE_MAX_ROUTE_PATHNAME_CHARS),
        grants: z.array(MobileWebBundleGrantNameSchema).max(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS)
      })
      .strict()
  )
  .max(BRIDGE_MAX_PAGE_ROUTES)

export type BridgePageRouteGrants = z.infer<typeof BridgePageRouteGrantsSchema>
