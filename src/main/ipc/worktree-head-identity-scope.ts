import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

// Which slice of a Git common dir's head identities a watcher burst can have
// moved. Absence of a scope always means "unknown" and must resolve to the full
// scope — only an explicit, provable narrowing may skip a metadata read.

export type WorktreeHeadIdentityScope = {
  /** Re-enumerate `worktrees/`: an admin entry may have appeared or vanished. */
  listing: boolean
  /** Re-read the primary checkout's HEAD. */
  primary: boolean
  /** Re-read every entry: a global signal (packed-refs rewrite, lost events). */
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

// Why: the watcher reports the admin dir name the OS gave it while the reader
// uses its own `readdir` name. Fold NFC/NFD and case so the two always agree —
// over-matching only costs one redundant read, under-matching loses an update.
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
