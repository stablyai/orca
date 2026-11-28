import {
  REMOTE_SERVER_UPDATE_CAPABILITY,
  REMOTE_SERVER_UPDATE_MOBILE_CAPABILITY
} from '../../../src/shared/remote-runtime/host-catalog/remote-server-update'
import type { HostUpdateSupport } from '../transport/connection/host-status-gates'

/** The phone can download and install the computer's Orca update itself, behind its confirm. */
export function canUpdateOrcaFromPhone(
  capabilities: readonly string[],
  support: HostUpdateSupport | undefined
): boolean {
  return (
    capabilities.includes(REMOTE_SERVER_UPDATE_MOBILE_CAPABILITY) &&
    capabilities.includes(REMOTE_SERVER_UPDATE_CAPABILITY) &&
    support?.automatic === true
  )
}
