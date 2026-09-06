import { MOBILE_WEB_SESSION_EVENT_MAX_BYTES } from '../../../src/shared/mobile-web/session-operation-contract'
import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_SESSION_GRANTS = [
  ...capabilityGrants('agentHistory', {
    snapshot: grantLimits(2 * 1024, 384 * 1024, 1, 8, 2),
    preview: grantLimits(512, 24 * 1024, 4, 12, 4),
    resume: grantLimits(1 * 1024, 2 * 1024, 1, 3, 0.25)
  }),
  ...capabilityGrants('session', {
    capabilities: grantLimits(256, 64 * 1024, 1, 4, 1),
    snapshot: grantLimits(1 * 1024, MOBILE_WEB_SESSION_EVENT_MAX_BYTES, 2, 6, 2),
    subscribe: grantLimits(1 * 1024, MOBILE_WEB_SESSION_EVENT_MAX_BYTES, 2, 4, 1),
    activate: grantLimits(2 * 1024, MOBILE_WEB_SESSION_EVENT_MAX_BYTES, 1, 12, 6),
    create: grantLimits(1 * 1024, 1 * 1024, 1, 4, 1),
    agentOptions: grantLimits(1 * 1024, 2 * 1024, 1, 4, 1),
    quickCommands: grantLimits(1 * 1024, 256 * 1024, 1, 4, 1),
    quickCommandMutate: grantLimits(8 * 1024, 256 * 1024, 1, 8, 2),
    createAgent: grantLimits(2 * 1024, 1 * 1024, 1, 4, 1),
    createQuickCommand: grantLimits(2 * 1024, 8 * 1024, 1, 4, 1),
    createBrowser: grantLimits(8 * 1024, 1 * 1024, 1, 4, 1),
    close: grantLimits(2 * 1024, 1 * 1024, 1, 8, 2)
  })
]
