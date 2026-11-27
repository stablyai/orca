export type KeptReason =
  | 'differs'
  | 'open'
  | 'linked'
  | 'missing_original'
  | 'changed'
  | 'error'
  // The ~/.codex original (or the copy) is compressed: kept, never decoded to compare.
  | 'compressed'
  // A Codex holds the thread's writer lock, or the locks couldn't be held.
  | 'busy'

export type CopiesTally = Record<KeptReason, number> & {
  /** Moved into the home's trash under the lock. */
  trashed: number
  bytesTrashed: number
  /** Deleted from the trash once their grace period ended and a recheck passed. */
  deleted: number
  bytesReclaimed: number
  /** Put back from the trash: the recheck no longer showed ~/.codex holding them. */
  restored: number
  deferred: number
}

const TALLY_KEYS = [
  'trashed',
  'bytesTrashed',
  'deleted',
  'bytesReclaimed',
  'restored',
  'deferred',
  'differs',
  'open',
  'linked',
  'missing_original',
  'changed',
  'error',
  'compressed',
  'busy'
] as const satisfies readonly (keyof CopiesTally)[]

export function emptyTally(): CopiesTally {
  return {
    trashed: 0,
    bytesTrashed: 0,
    deleted: 0,
    bytesReclaimed: 0,
    restored: 0,
    deferred: 0,
    differs: 0,
    open: 0,
    linked: 0,
    missing_original: 0,
    changed: 0,
    error: 0,
    compressed: 0,
    busy: 0
  }
}

export function addTally(into: CopiesTally, from: CopiesTally): void {
  for (const key of TALLY_KEYS) {
    into[key] += from[key]
  }
}
