import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from '../../../src/shared/mobile-web/bridge-contract'
import { MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS } from '../../../src/shared/mobile-web/source-control-operation-contract'
import { capabilityGrants, grantLimits } from './mobile-web-production-grant-table'

export const MOBILE_WEB_PRODUCTION_SOURCE_CONTROL_REVIEW_GRANTS = capabilityGrants(
  'sourceControl',
  {
    reviewMetadata: grantLimits(2 * 1024, MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES, 2, 8, 2),
    reviewMetadataUpdate: grantLimits(
      MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES,
      MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES,
      1,
      8,
      2
    ),
    reviewLink: grantLimits(2 * 1024, 2 * 1024, 2, 8, 2),
    reviewLinkUpdate: grantLimits(4 * 1024, 2 * 1024, 1, 4, 1),
    reviewDiff: grantLimits(8 * 1024, 192 * 1024 + MOBILE_WEB_DIFF_LINE_MAX_CHARACTERS, 2, 12, 3),
    reviewOpen: grantLimits(4 * 1024, 256, 1, 8, 2),
    reviewTerminalSend: grantLimits(128 * 1024, 256, 1, 4, 1)
  }
)
