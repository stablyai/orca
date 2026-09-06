import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS = capabilityGrants('navigation', {
  route: grantLimits(256, 256, 1, 8, 2),
  reconnect: grantLimits(256, 256, 1, 4, 1),
  removeHost: grantLimits(256, 256, 1, 2, 0.25)
})
