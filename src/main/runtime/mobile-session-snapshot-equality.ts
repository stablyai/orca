import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

// Compare rebuilt snapshots by value, excluding newly minted publicationEpoch/snapshotVersion.
export function headlessMobileSnapshotContentUnchanged(
  existing: RuntimeMobileSessionTabsSnapshot,
  next: RuntimeMobileSessionTabsSnapshot
): boolean {
  if (
    existing.worktree !== next.worktree ||
    existing.activeGroupId !== next.activeGroupId ||
    existing.activeTabId !== next.activeTabId ||
    existing.activeTabType !== next.activeTabType
  ) {
    return false
  }
  // Every graph sync visits persisted workspaces; avoid allocating serialized trees for equality.
  return (
    mobileSnapshotValueEqual(existing.tabs, next.tabs) &&
    mobileSnapshotValueEqual(existing.tabGroups ?? null, next.tabGroups ?? null) &&
    mobileSnapshotValueEqual(existing.tabGroupLayout ?? null, next.tabGroupLayout ?? null)
  )
}

// Plain snapshot JSON equality ignores key order; false negatives cost only a coalesced no-op emit.
export function mobileSnapshotValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    for (let index = 0; index < a.length; index++) {
      if (!mobileSnapshotValueEqual(a[index], b[index])) {
        return false
      }
    }
    return true
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aRecord = a as Record<string, unknown>
    const bRecord = b as Record<string, unknown>
    const aKeys = Object.keys(aRecord)
    if (aKeys.length !== Object.keys(bRecord).length) {
      return false
    }
    for (const key of aKeys) {
      if (!Object.hasOwn(bRecord, key) || !mobileSnapshotValueEqual(aRecord[key], bRecord[key])) {
        return false
      }
    }
    return true
  }
  return false
}

export function isHeadlessBuiltPublication(publicationEpoch: string): boolean {
  const base = publicationEpoch.split(':headless-merge:')[0] ?? publicationEpoch
  return base.startsWith('headless:') || base.startsWith('headless-hydrated:')
}

/** Compare occupant/publication/retirement identity, retaining absent proofs; fresh host-built stamps count as one. */
export function mobileSnapshotIdentityUnchanged(
  existing: RuntimeMobileSessionTabsSnapshot,
  next: RuntimeMobileSessionTabsSnapshot
): boolean {
  return (
    (next.worktreeInstanceId === undefined ||
      next.worktreeInstanceId === existing.worktreeInstanceId) &&
    (existing.publicationEpoch === next.publicationEpoch ||
      (isHeadlessBuiltPublication(existing.publicationEpoch) &&
        isHeadlessBuiltPublication(next.publicationEpoch))) &&
    (next.retiredTerminalSurfaces === undefined ||
      mobileSnapshotValueEqual(next.retiredTerminalSurfaces, existing.retiredTerminalSurfaces))
  )
}
