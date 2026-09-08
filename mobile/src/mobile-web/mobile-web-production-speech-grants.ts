import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_SPEECH_GRANTS = capabilityGrants('speech', {
  subscribe: grantLimits(256, 256, 1, 4, 1),
  start: grantLimits(256, 512, 1, 4, 0.5),
  stop: grantLimits(256, 48 * 1024, 1, 4, 0.5),
  cancel: grantLimits(256, 256, 1, 8, 2)
})
