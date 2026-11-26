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
  deleted: number
  bytesReclaimed: number
  deferred: number
}

const TALLY_KEYS = [
  'deleted',
  'bytesReclaimed',
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
    deleted: 0,
    bytesReclaimed: 0,
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
