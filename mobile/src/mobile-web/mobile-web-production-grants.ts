import { MOBILE_WEB_PRODUCTION_FILE_GRANTS } from './mobile-web-production-file-grants'
import { capabilityGrants, grantLimits, indexGrants } from './mobile-web-production-grant-table'
import { MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS } from './mobile-web-production-navigation-grants'
import { MOBILE_WEB_PRODUCTION_NATIVE_GRANTS } from './mobile-web-production-native-grants'
import { MOBILE_WEB_PRODUCTION_NATIVE_CHAT_GRANTS } from './mobile-web-production-native-chat-grants'
import { MOBILE_WEB_PRODUCTION_SPEECH_GRANTS } from './mobile-web-production-speech-grants'
import { MOBILE_WEB_PRODUCTION_TERMINAL_GRANTS } from './mobile-web-production-terminal-grants'
import { MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS } from './mobile-web-production-workspace-creation-grants'

export type { MobileWebOperationGrant } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_GRANTS = [
  ...capabilityGrants('workspace', {
    hostSubscribe: grantLimits(600 * 1024, 1024, 8, 8, 2),
    hostRequest: grantLimits(600 * 1024, 600 * 1024, 16, 48, 24),
    snapshot: grantLimits(1 * 1024, 128 * 1024, 2, 4, 1)
  }),
  ...capabilityGrants('account', {
    resetCreditCapability: grantLimits(256, 256, 2, 4, 1),
    consumeResetCredit: grantLimits(8 * 1024, 96 * 1024, 1, 2, 0.25)
  }),
  ...MOBILE_WEB_PRODUCTION_TERMINAL_GRANTS,
  ...MOBILE_WEB_PRODUCTION_FILE_GRANTS,
  ...capabilityGrants('sourceControl', {
    generateCommitMessage: grantLimits(4 * 1024, 16 * 1024, 1, 4, 0.25),
    cancelCommitMessageGeneration: grantLimits(2 * 1024, 2 * 1024, 2, 8, 4)
  }),
  ...MOBILE_WEB_PRODUCTION_SPEECH_GRANTS,
  ...MOBILE_WEB_PRODUCTION_NATIVE_GRANTS,
  ...MOBILE_WEB_PRODUCTION_NATIVE_CHAT_GRANTS,
  ...MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS,
  ...MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS
]

export const MOBILE_WEB_PRODUCTION_GRANT_INDEX = indexGrants(MOBILE_WEB_PRODUCTION_GRANTS)
