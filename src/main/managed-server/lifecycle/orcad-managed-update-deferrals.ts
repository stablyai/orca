import type { OrcadManagedDeferral } from '../../../shared/orcad-managed-runtime'
import { compareAppVersions } from '../../../shared/app-version'

type RecordedDeferral = OrcadManagedDeferral & { deferredAt: string }

type StoredDeferral = RecordedDeferral & {
  /** The host's active version when the deferral was recorded, so a later move is visible. */
  activeAtDeferral: string | null
}

const deferrals = new Map<string, StoredDeferral>()

export function recordManagedOrcadUpdateDeferral(
  environmentId: string,
  deferral: OrcadManagedDeferral,
  activeAtDeferral: string | null,
  now = new Date()
): void {
  deferrals.set(environmentId, {
    ...deferral,
    deferredAt: now.toISOString(),
    activeAtDeferral
  })
}

export function clearManagedOrcadUpdateDeferral(environmentId: string): void {
  deferrals.delete(environmentId)
}

function readManagedOrcadUpdateDeferral(environmentId: string): StoredDeferral | null {
  return deferrals.get(environmentId) ?? null
}

/** Forget a deferral once the host's active version moves at all — it describes a host state that
 *  no longer exists, and same-release builds cannot be ordered by version string (#38400). */
export function currentManagedOrcadUpdateDeferral(
  environmentId: string,
  activeVersion: string | null
): RecordedDeferral | null {
  const stored = readManagedOrcadUpdateDeferral(environmentId)
  if (!stored) {
    return null
  }
  const moved = stored.activeAtDeferral !== activeVersion
  const reachedOrPassed =
    activeVersion !== null &&
    (activeVersion === stored.candidateVersion ||
      compareAppVersions(activeVersion, stored.candidateVersion) > 0)
  if (moved || reachedOrPassed) {
    clearManagedOrcadUpdateDeferral(environmentId)
    return null
  }
  return {
    outcome: stored.outcome,
    candidateVersion: stored.candidateVersion,
    code: stored.code,
    reason: stored.reason,
    ...(stored.forceable === undefined ? {} : { forceable: stored.forceable }),
    deferredAt: stored.deferredAt
  }
}
