import type { OrcadManagedDeferral } from '../../../shared/orcad-managed-runtime'
import { compareAppVersions } from '../../../shared/app-version'

type RecordedDeferral = OrcadManagedDeferral & { deferredAt: string }

const deferrals = new Map<string, RecordedDeferral>()

export function recordManagedOrcadUpdateDeferral(
  environmentId: string,
  deferral: OrcadManagedDeferral,
  now = new Date()
): void {
  deferrals.set(environmentId, { ...deferral, deferredAt: now.toISOString() })
}

export function clearManagedOrcadUpdateDeferral(environmentId: string): void {
  deferrals.delete(environmentId)
}

function readManagedOrcadUpdateDeferral(environmentId: string): RecordedDeferral | null {
  return deferrals.get(environmentId) ?? null
}

/** Forget deferrals resolved by another desktop activating the candidate or a newer release. */
export function currentManagedOrcadUpdateDeferral(
  environmentId: string,
  activeVersion: string | null
): RecordedDeferral | null {
  const deferral = readManagedOrcadUpdateDeferral(environmentId)
  if (
    deferral &&
    activeVersion &&
    (activeVersion === deferral.candidateVersion ||
      compareAppVersions(activeVersion, deferral.candidateVersion) > 0)
  ) {
    clearManagedOrcadUpdateDeferral(environmentId)
    return null
  }
  return deferral
}
