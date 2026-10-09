/**
 * The downgrade rule every orcad activation on a shared host applies: a build may not start over
 * state a newer Orca's orcad may already have migrated.
 */
import { compareAppVersions } from '../../shared/app-version'
import type { OrcadActivationRecord } from './orcad-activation-record'

export type OrcadHostVersionRefusal = 'host-newer'

export function refuseOrcadHostDowngrade(
  record: OrcadActivationRecord,
  candidateVersion: string,
  appVersion: string
): OrcadHostVersionRefusal | null {
  // Restarting the very build that was stopped cannot downgrade anything.
  if (record.active === null && record.previous === candidateVersion) {
    return null
  }
  // Why an unnamed version is admitted: every Stop before the field existed omits it, so refusing
  // would strand those hosts for good; only a provably newer host is refused.
  if (!record.activeAppVersion) {
    return null
  }
  return compareAppVersions(record.activeAppVersion, appVersion) > 0 ? 'host-newer' : null
}
