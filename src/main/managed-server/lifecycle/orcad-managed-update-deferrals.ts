import type { OrcadManagedDeferral } from '../../../shared/orcad-managed-runtime'

type RecordedDeferral = OrcadManagedDeferral & { deferredAt: string }

type StoredDeferral = RecordedDeferral & {
  /** The host's active version when the deferral was recorded. */
  activeAtDeferral: string | null
}

const deferrals = new Map<string, StoredDeferral>()

export function recordManagedOrcadUpdateDeferral(
  environmentId: string,
  deferral: OrcadManagedDeferral,
  activeAtDeferral: string | null,
  now = new Date()
): void {
  deferrals.set(environmentId, { ...deferral, deferredAt: now.toISOString(), activeAtDeferral })
}

export function clearManagedOrcadUpdateDeferral(environmentId: string): void {
  deferrals.delete(environmentId)
}

/** Forget a deferral once the host's active version moves: it described a host state that is gone,
 *  and builds of one release differ only by an unorderable content hash (#38400). */
export function currentManagedOrcadUpdateDeferral(
  environmentId: string,
  activeVersion: string | null
): RecordedDeferral | null {
  const stored = deferrals.get(environmentId)
  if (!stored) {
    return null
  }
  if (stored.activeAtDeferral !== activeVersion) {
    clearManagedOrcadUpdateDeferral(environmentId)
    return null
  }
  const { activeAtDeferral: _activeAtDeferral, ...deferral } = stored
  return deferral
}
