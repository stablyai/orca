import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

// Why: content equality for the hydrate's idempotence check — compares every
// client-visible field EXCEPT publicationEpoch/snapshotVersion (both are
// freshly minted on each rebuild and would defeat the comparison). Tab and
// group objects are rebuilt each hydrate, so compare by value, not identity.
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
  // Why: this runs per persisted worktree on EVERY graph sync whenever a
  // serve PTY exists, so compare structurally instead of stable-stringifying
  // both sides (which allocated six full serialized trees per worktree).
  return (
    mobileSnapshotValueEqual(existing.tabs, next.tabs) &&
    mobileSnapshotValueEqual(existing.tabGroups ?? null, next.tabGroups ?? null) &&
    mobileSnapshotValueEqual(existing.tabGroupLayout ?? null, next.tabGroupLayout ?? null)
  )
}

// Deep structural equality over plain snapshot JSON (objects/arrays/scalars).
// Key order is irrelevant; a mismatch only costs a coalesced no-op emit.
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

/** Whether rows were built by the host itself (not a window's publication, merges included). */
export function isHeadlessBuiltPublication(publicationEpoch: string): boolean {
  const base = publicationEpoch.split(':headless-merge:')[0] ?? publicationEpoch
  return base.startsWith('headless:') || base.startsWith('headless-hydrated:')
}

/**
 * Whether a write keeps the stored occupant, publication and retirement proofs; an absent occupant
 * or proof keeps them. Two host-built stamps count as one: each rebuild mints its own.
 */
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
