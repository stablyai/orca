import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_BROWSER_GRANTS = capabilityGrants('browser', {
  subscribe: grantLimits(4 * 1024, 1 * 1024, 1, 4, 1),
  navigate: grantLimits(8 * 1024, 8 * 1024, 1, 8, 2),
  back: grantLimits(2 * 1024, 256, 2, 12, 4),
  forward: grantLimits(2 * 1024, 256, 2, 12, 4),
  reload: grantLimits(2 * 1024, 256, 2, 12, 4),
  dialog: grantLimits(2 * 1024, 256, 2, 12, 4),
  pointer: grantLimits(4 * 1024, 256, 2, 40, 20),
  keyboard: grantLimits(40 * 1024, 256, 2, 20, 10)
})
