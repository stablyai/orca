import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS = capabilityGrants('workspace', {
  creationCreateBlank: grantLimits(64 * 1024, 2 * 1024, 1, 2, 0.1),
  creationCreateFromSource: grantLimits(64 * 1024, 2 * 1024, 1, 2, 0.1)
})
