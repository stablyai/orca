import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_SPEECH_GRANTS = capabilityGrants('speech', {
  subscribe: grantLimits(256, 256, 1, 4, 1),
  setup: grantLimits(256, 32 * 1024, 1, 8, 2),
  downloadModel: grantLimits(512, 256, 1, 3, 0.25),
  deleteModel: grantLimits(512, 32 * 1024, 1, 3, 0.25),
  configure: grantLimits(1 * 1024, 32 * 1024, 1, 6, 1),
  start: grantLimits(256, 512, 1, 4, 0.5),
  stop: grantLimits(256, 48 * 1024, 1, 4, 0.5),
  cancel: grantLimits(256, 256, 1, 8, 2)
})
