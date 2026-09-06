import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_TERMINAL_GRANTS = capabilityGrants('terminal', {
  clipboardPaste: grantLimits(1 * 1024, 256, 1, 4, 1),
  attachImage: grantLimits(1 * 1024, 256, 1, 3, 0.5),
  subscribe: grantLimits(4 * 1024, 1 * 1024, 4, 8, 2),
  input: grantLimits(32 * 1024, 256, 8, 120, 120),
  queryReply: grantLimits(32 * 1024, 256, 8, 120, 120),
  resize: grantLimits(1 * 1024, 256, 2, 30, 15),
  visibility: grantLimits(1 * 1024, 256, 2, 12, 4),
  displayMode: grantLimits(1 * 1024, 256, 1, 6, 2),
  clear: grantLimits(512, 256, 1, 4, 1),
  rename: grantLimits(1 * 1024, 256, 1, 4, 1),
  resync: grantLimits(1 * 1024, 256, 1, 4, 1),
  ack: grantLimits(1 * 1024, 256, 8, 240, 240),
  cancel: grantLimits(1 * 1024, 256, 2, 12, 4)
})
