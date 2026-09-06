import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from '../../../src/shared/mobile-web/bridge-contract'
import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_NATIVE_GRANTS = capabilityGrants('native', {
  alert: grantLimits(32 * 1024, 256, 1, 4, 1),
  clipboardAvailability: grantLimits(256, 256, 1, 8, 2),
  hapticSelection: grantLimits(256, 256, 1, 12, 8),
  hapticFeedback: grantLimits(256, 256, 1, 16, 8),
  clipboardWrite: grantLimits(MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES, 256, 1, 4, 1),
  openExternal: grantLimits(8 * 1024, 256, 1, 6, 2),
  terminalPreferences: grantLimits(256, 1 * 1024, 1, 8, 2),
  terminalAccessoryPreferences: grantLimits(256, 32 * 1024, 1, 8, 2),
  terminalCustomKeysUpdate: grantLimits(32 * 1024, 256, 1, 8, 2),
  terminalTextScaleUpdate: grantLimits(256, 256, 1, 8, 2),
  sessionChatDraftRead: grantLimits(2 * 1024, 8 * 1024, 2, 12, 4),
  sessionChatDraftWrite: grantLimits(8 * 1024, 256, 2, 16, 8)
})
