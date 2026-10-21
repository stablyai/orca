// Verbatim owner readers from the release before machine owners (origin/main 75b6fa2201c2),
// with the owner type widened from its literal so the frozen logic can read a newer row.
// Do not update these to match current code: they are what a downgraded build runs.
type PreviousReleaseOwner = { type: string; runtimeId: string }

const LEGACY_MANAGED_ORCAD_RUNTIME_ID_PREFIX = 'managed-orcad:'

export function previousGetLegacyManagedOrcadOwnerEnvironmentId(
  owner: PreviousReleaseOwner | undefined
): string | null {
  if (!owner?.runtimeId.startsWith(LEGACY_MANAGED_ORCAD_RUNTIME_ID_PREFIX)) {
    return null
  }
  return owner.runtimeId.slice(LEGACY_MANAGED_ORCAD_RUNTIME_ID_PREFIX.length) || null
}

export function previousIsEphemeralRuntimeSshOwner(
  owner: PreviousReleaseOwner | undefined
): boolean {
  return (
    owner?.type === 'on-demand-runtime' &&
    previousGetLegacyManagedOrcadOwnerEnvironmentId(owner) === null
  )
}

export function previousManagedOrcadServerName(target: {
  label: string
  owner?: PreviousReleaseOwner
}): string {
  const runtimeId = previousIsEphemeralRuntimeSshOwner(target.owner)
    ? target.owner?.runtimeId
    : undefined
  return runtimeId ? `${target.label} VM ${runtimeId.slice(-8)}` : target.label
}

/** ssh-connection-store `isRuntimeOwnedSshTarget`: hidden from SSH-host surfaces. */
export function previousIsRuntimeOwnedSshTarget(target: { owner?: unknown }): boolean {
  return target.owner !== undefined
}
