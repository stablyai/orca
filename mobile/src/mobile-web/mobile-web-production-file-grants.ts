import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_FILE_GRANTS = capabilityGrants('file', {
  markdownDraftRead: grantLimits(4 * 1024, 353624, 2, 8, 2),
  markdownDraftWrite: grantLimits(353624, 256, 1, 12, 4)
})
