/** Reject activation over state a newer host build may already have migrated. */
import { compareAppVersions } from '../../shared/app-version'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'

export type OrcadHostVersionRefusal = 'host-newer'

export function refuseOrcadHostDowngrade(
  record: OrcadActivationRecord,
  candidateVersion: string,
  appVersion: string
): OrcadHostVersionRefusal | null {
  // Restarting the stopped build cannot downgrade state.
  if (record.active === null && record.previous === candidateVersion) {
    return null
  }
  // Older Stop records omit app version; refuse only proven newer hosts or they would be stranded.
  if (!record.activeAppVersion) {
    return null
  }
  return compareAppVersions(record.activeAppVersion, appVersion) > 0 ? 'host-newer' : null
}
