import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

// Missing scope means unknown and requires a full read; only proven narrowing may skip metadata.

export type WorktreeHeadIdentityScope = {
  /** Re-enumerate `worktrees/`: an admin entry may have appeared or vanished. */
  listing: boolean
  primary: boolean
  /** Global signals, including packed-refs writes or event loss, require every entry. */
  all: boolean
  /** Admin entry dir keys (see `headIdentityEntryKey`) whose head may have moved. */
  entryNames: ReadonlySet<string>
}

const NO_ENTRY_NAMES: ReadonlySet<string> = new Set<string>()

export const EMPTY_HEAD_IDENTITY_SCOPE: WorktreeHeadIdentityScope = Object.freeze({
  listing: false,
  primary: false,
  all: false,
  entryNames: NO_ENTRY_NAMES
})

export const FULL_HEAD_IDENTITY_SCOPE: WorktreeHeadIdentityScope = Object.freeze({
  listing: true,
  primary: true,
  all: true,
  entryNames: NO_ENTRY_NAMES
})

export const PRIMARY_HEAD_IDENTITY_SCOPE: WorktreeHeadIdentityScope = Object.freeze({
  listing: false,
  primary: true,
  all: false,
  entryNames: NO_ENTRY_NAMES
})

export const LISTING_HEAD_IDENTITY_SCOPE: WorktreeHeadIdentityScope = Object.freeze({
  listing: true,
  primary: false,
  all: false,
  entryNames: NO_ENTRY_NAMES
})

// Fold case and Unicode to match watcher/readdir names; overmatching costs a read, undermatching loses updates.
export function headIdentityEntryKey(name: string): string {
  return normalizeRuntimePathForComparison(name).toLowerCase()
}

export function headIdentityScopeForEntry(name: string): WorktreeHeadIdentityScope {
  return {
    listing: false,
    primary: false,
    all: false,
    entryNames: new Set([headIdentityEntryKey(name)])
  }
}

export function mergeHeadIdentityScopes(
  first: WorktreeHeadIdentityScope,
  second: WorktreeHeadIdentityScope
): WorktreeHeadIdentityScope {
  if (first.all) {
    return first
  }
  if (second.all) {
    return second
  }
  if (second.entryNames.size === 0 && !second.listing && !second.primary) {
    return first
  }
  if (first.entryNames.size === 0 && !first.listing && !first.primary) {
    return second
  }
  return {
    listing: first.listing || second.listing,
    primary: first.primary || second.primary,
    all: false,
    entryNames: new Set([...first.entryNames, ...second.entryNames])
  }
}

export function isEmptyHeadIdentityScope(scope: WorktreeHeadIdentityScope): boolean {
  return !scope.all && !scope.listing && !scope.primary && scope.entryNames.size === 0
}
