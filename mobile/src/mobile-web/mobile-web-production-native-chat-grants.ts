import { MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_NATIVE_CHAT_GRANTS = capabilityGrants('nativeChat', {
  read: grantLimits(2 * 1024, MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES, 2, 8, 2),
  subscribe: grantLimits(2 * 1024, MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES, 2, 4, 1),
  sendMessage: grantLimits(72 * 1024, 256, 1, 12, 4),
  prepareCommit: grantLimits(2 * 1024, 256, 1, 12, 4),
  respond: grantLimits(8 * 1024, 256, 1, 20, 8),
  stop: grantLimits(2 * 1024, 256, 1, 8, 2),
  attachImage: grantLimits(2 * 1024, 272 * 1024, 1, 8, 2),
  pasteImages: grantLimits(8 * 1024, 256, 1, 12, 4),
  releaseImages: grantLimits(8 * 1024, 256, 2, 20, 8),
  pendingRead: grantLimits(2 * 1024, 72 * 1024, 2, 12, 4),
  pendingWrite: grantLimits(72 * 1024, 256, 2, 16, 8),
  fileSearch: grantLimits(4 * 1024, 32 * 1024, 2, 12, 4),
  openFile: grantLimits(8 * 1024, 256, 1, 12, 4),
  readability: grantLimits(1 * 1024, 256, 2, 4, 1)
})
