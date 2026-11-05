import type { OrcadManagedDeferral } from '../../../shared/orcad-managed-runtime'
import { compareAppVersions } from '../../../shared/app-version'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'

type RecordedDeferral = OrcadManagedDeferral & { deferredAt: string }

type StoredDeferral = RecordedDeferral & {
  /** The host's active version when the deferral was recorded, so a later move is visible. */
  activeAtDeferral: string | null
}

const deferrals = new Map<string, StoredDeferral>()

/** Remember a failed activation for this host, with the active version it was recorded against. */
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

/** Drop any recorded deferral for the environment. */
export function clearManagedOrcadUpdateDeferral(environmentId: string): void {
  deferrals.delete(environmentId)
}

/** Return the stored deferral, baseline included, without judging whether it still applies. */
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

/** Record a deferral against the host as it stands after deploy: another desktop may have moved it
 *  during the deploy, and a stale baseline would make the next status read drop the note (#38400).
 *  `enabled` is false for a policy refusal, which is final for this host rather than retryable. */
export async function recordManagedOrcadUpdateDeferralFromHost(
  environmentId: string,
  deferral: OrcadManagedDeferral,
  target: Parameters<typeof readOrcadActivationRecord>[0],
  fallbackActive: string | null,
  enabled: boolean
): Promise<void> {
  if (!enabled) {
    return
  }
  const active = await readOrcadActivationRecord(target)
    .then((record) => record.active)
    .catch(() => fallbackActive)
  recordManagedOrcadUpdateDeferral(environmentId, deferral, active)
}

/** The deferral a failed activation reports, with the force escape the caller decided. */
export function managedOrcadUpdateDeferral(
  result: { fullVersion: string; code: string; reason: string },
  forceable: boolean
): OrcadManagedDeferral {
  return {
    outcome: 'deferred',
    candidateVersion: result.fullVersion,
    code: result.code,
    reason: result.reason,
    forceable
  }
}
