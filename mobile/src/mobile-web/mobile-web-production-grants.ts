import { MOBILE_WEB_PRODUCTION_BROWSER_GRANTS } from './mobile-web-production-browser-grants'
import { MOBILE_WEB_PRODUCTION_FILE_GRANTS } from './mobile-web-production-file-grants'
import { capabilityGrants, grantLimits, indexGrants } from './mobile-web-production-grant-table'
import { MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS } from './mobile-web-production-navigation-grants'
import { MOBILE_WEB_PRODUCTION_NATIVE_GRANTS } from './mobile-web-production-native-grants'
import { MOBILE_WEB_PRODUCTION_NATIVE_CHAT_GRANTS } from './mobile-web-production-native-chat-grants'
import { MOBILE_WEB_PRODUCTION_SESSION_GRANTS } from './mobile-web-production-session-grants'
import { MOBILE_WEB_PRODUCTION_SOURCE_CONTROL_GRANTS } from './mobile-web-production-source-control-grants'
import { MOBILE_WEB_PRODUCTION_SPEECH_GRANTS } from './mobile-web-production-speech-grants'
import { MOBILE_WEB_PRODUCTION_TASK_GRANTS } from './mobile-web-production-task-grants'
import { MOBILE_WEB_PRODUCTION_TERMINAL_GRANTS } from './mobile-web-production-terminal-grants'
import { MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS } from './mobile-web-production-workspace-creation-grants'

export type { MobileWebOperationGrant } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_GRANTS = [
  ...capabilityGrants('workspace', {
    snapshot: grantLimits(1 * 1024, 128 * 1024, 2, 4, 1),
    repositories: grantLimits(256, 128 * 1024, 2, 4, 1),
    subscribe: grantLimits(256, 1 * 1024, 1, 4, 1),
    activate: grantLimits(1 * 1024, 1 * 1024, 1, 6, 2),
    update: grantLimits(1 * 1024, 1 * 1024, 2, 12, 4),
    remove: grantLimits(1 * 1024, 1 * 1024, 1, 4, 0.5)
  }),
  ...capabilityGrants('settings', {
    snapshot: grantLimits(256, 32 * 1024, 2, 4, 1),
    update: grantLimits(32 * 1024, 256, 1, 8, 2)
  }),
  ...capabilityGrants('account', {
    snapshot: grantLimits(256, 96 * 1024, 2, 6, 1)
  }),
  ...MOBILE_WEB_PRODUCTION_TASK_GRANTS,
  ...capabilityGrants('account', {
    select: grantLimits(1 * 1024, 256, 1, 4, 1),
    resetCreditCapability: grantLimits(256, 256, 2, 4, 1),
    consumeResetCredit: grantLimits(8 * 1024, 96 * 1024, 1, 2, 0.25),
    subscribe: grantLimits(256, 96 * 1024, 1, 4, 1)
  }),
  ...MOBILE_WEB_PRODUCTION_SESSION_GRANTS,
  ...MOBILE_WEB_PRODUCTION_TERMINAL_GRANTS,
  ...MOBILE_WEB_PRODUCTION_BROWSER_GRANTS,
  ...MOBILE_WEB_PRODUCTION_FILE_GRANTS,
  ...MOBILE_WEB_PRODUCTION_SOURCE_CONTROL_GRANTS,
  ...MOBILE_WEB_PRODUCTION_SPEECH_GRANTS,
  ...MOBILE_WEB_PRODUCTION_NATIVE_GRANTS,
  ...MOBILE_WEB_PRODUCTION_NATIVE_CHAT_GRANTS,
  ...MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS,
  ...MOBILE_WEB_PRODUCTION_WORKSPACE_CREATION_GRANTS,
  ...capabilityGrants('provider', {
    review: grantLimits(4 * 1024, 192 * 1024, 2, 6, 1),
    reviewCreationEligibility: grantLimits(4 * 1024, 48 * 1024, 2, 6, 1),
    reviewCreate: grantLimits(48 * 1024, 4 * 1024, 1, 2, 0.1),
    reviewGenerateFields: grantLimits(48 * 1024, 48 * 1024, 1, 2, 0.1),
    reviewDiff: grantLimits(4 * 1024, 128 * 1024, 2, 8, 2),
    reviewQuery: grantLimits(4 * 1024, 192 * 1024, 2, 6, 1),
    mutateReview: grantLimits(16 * 1024, 4 * 1024, 1, 4, 0.5),
    manageReview: grantLimits(16 * 1024, 4 * 1024, 1, 4, 0.5),
    submitReview: grantLimits(96 * 1024, 8 * 1024, 1, 2, 0.1)
  })
]

export const MOBILE_WEB_PRODUCTION_GRANT_INDEX = indexGrants(MOBILE_WEB_PRODUCTION_GRANTS)
