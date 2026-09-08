import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_NATIVE_CHAT_GRANTS = capabilityGrants('nativeChat', {
  attachImage: grantLimits(2 * 1024, 272 * 1024, 1, 8, 2),
  pasteImages: grantLimits(8 * 1024, 256, 1, 12, 4),
  releaseImages: grantLimits(8 * 1024, 256, 2, 20, 8),
  pendingRead: grantLimits(2 * 1024, 72 * 1024, 2, 12, 4),
  pendingWrite: grantLimits(72 * 1024, 256, 2, 16, 8)
})
