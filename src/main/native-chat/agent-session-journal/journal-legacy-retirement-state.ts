import { z } from 'zod'
import {
  LEGACY_SOURCE_ARTIFACTS,
  LEGACY_SOURCE_REFUSALS,
  type LegacySourceArtifact,
  type LegacySourceRefusalReason
} from './journal-legacy-retention-error'

/**
 * Saved beside the copy receipt. Builds from before on-update retirement read the v1 key, so this
 * one never collides with their grace rows; those are left untouched.
 */
export const JOURNAL_LEGACY_RETIREMENT = 'journal.legacy-retirement.v2'
export const LEGACY_SOURCE_REFUSAL_POLICY = 3
/**
 * Per chat, the original's record and waiting text where it and this store differ, kept verbatim
 * once the original retires: no content says which side changed last, so neither is dropped.
 */
export const JOURNAL_LEGACY_ORIGINAL = 'journal.legacy-original:'

/** What the writer reports before an attempt; "retired" itself is the original being absent. */
export type JournalLegacyRetirementState = {
  receipt: string | null
  kept: boolean
  convertedBy: string | null
  retirement: string | null
  /** What this store last reported about the cleanup, so a repeat isn't sent again. */
  reported: string | null
}

/** Where to note what was last reported; nothing else reads it. */
export const JOURNAL_LEGACY_RETIREMENT_REPORTED = 'journal.legacy-retirement-reported.v1'

/** What one walk of the proof saw, for reporting only: it decides nothing. */
export type LegacyProofCounts = {
  chats: number
  /** Converted here before the proof reached them. */
  alreadyConverted: number
  /** Converted by the proof itself: what the proof adds to the store. */
  newlyConverted: number
  /** Deleted here, so kept only as the original's version. */
  deletedHere: number
  /** Drafts: a record and no history, so nothing converts. */
  drafts: number
  originals: number
  copies: number
}

/**
 * The proof of this original into this store finished, and this build keeps the file. A later
 * launch reads this instead of walking again; a build that deletes walks again in full.
 */
export type LegacySourceHeld = {
  version: 2
  phase: 'held'
  layout: typeof LEGACY_PROOF_LAYOUT
  proof: string
  store: string
  /** Null when nothing was measured: a walk resumed at the copies of a deletion cut short. */
  counts: LegacyProofCounts | null
  /** The proof walked every page in one run rather than resuming saved progress. */
  whole: boolean
}

/** A proof that failed for a reason the frozen original can't outgrow, keyed to that original. */
export type LegacySourceRefusal = {
  version: 2
  phase: 'refused'
  policy: typeof LEGACY_SOURCE_REFUSAL_POLICY
  proof: string
  store: string
  reason: LegacySourceRefusalReason
  /** Which shapes builds left behind an inventory refusal saw; for reporting only. */
  artifact?: LegacySourceArtifact
}

/** The proof's page layout; progress saved under another is walked again from the start. */
export const LEGACY_PROOF_LAYOUT = 1
/** The proof's last phases, the reconcile's copies, start at this table (after content and claims). */
export const LEGACY_PROOF_COPIES_TABLE = 7

/**
 * The commit that makes every converted row durable before the original is unlinked. It names
 * the original it retires; a later launch whose deletion of the same original didn't go through
 * resumes at the copies when the layout matches.
 */
export type LegacySourceRetiring = {
  version: 2
  phase: 'retiring'
  layout: typeof LEGACY_PROOF_LAYOUT
  proof: string
  store: string
}

/**
 * How far the proof of this original into this store got, so a later launch resumes there instead
 * of walking every chat again. Not durable: a lost write only repeats work.
 */
export type LegacySourceProving = {
  version: 2
  phase: 'proving'
  layout: typeof LEGACY_PROOF_LAYOUT
  proof: string
  store: string
  cursor: { table: number; after: string | null; epoch?: string }
  /** What the walk counted from its first page; absent when it began from older progress. */
  counts?: LegacyProofCounts
}

export function decodeLegacySourceProving(value: string | null): LegacySourceProving | null {
  let data: unknown
  try {
    data = value ? JSON.parse(value) : null
  } catch {
    return null
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('phase' in data) ||
    data.phase !== 'proving' ||
    !('version' in data) ||
    data.version !== 2 ||
    !('proof' in data) ||
    typeof data.proof !== 'string' ||
    !('store' in data) ||
    typeof data.store !== 'string' ||
    !('layout' in data) ||
    data.layout !== LEGACY_PROOF_LAYOUT ||
    !('cursor' in data) ||
    !data.cursor ||
    typeof data.cursor !== 'object'
  ) {
    return null
  }
  const cursor: object = data.cursor
  const table = 'table' in cursor ? cursor.table : undefined
  const after = 'after' in cursor ? cursor.after : undefined
  const epoch = 'epoch' in cursor ? cursor.epoch : undefined
  if (
    typeof table !== 'number' ||
    !Number.isInteger(table) ||
    table < 0 ||
    (after !== null && typeof after !== 'string') ||
    (epoch !== undefined && typeof epoch !== 'string')
  ) {
    return null
  }
  return {
    version: 2,
    phase: 'proving',
    layout: LEGACY_PROOF_LAYOUT,
    proof: data.proof,
    store: data.store,
    cursor: { table, after, ...(epoch === undefined ? {} : { epoch }) },
    ...decodeCounts('counts' in data ? data.counts : undefined)
  }
}

export function decodeLegacySourceRefusal(value: string | null): LegacySourceRefusal | null {
  let data: unknown
  try {
    data = value ? JSON.parse(value) : null
  } catch {
    return null
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('phase' in data) ||
    data.phase !== 'refused' ||
    !('version' in data) ||
    data.version !== 2 ||
    !('policy' in data) ||
    data.policy !== LEGACY_SOURCE_REFUSAL_POLICY ||
    !('proof' in data) ||
    typeof data.proof !== 'string' ||
    !('store' in data) ||
    typeof data.store !== 'string' ||
    !('reason' in data) ||
    typeof data.reason !== 'string'
  ) {
    return null
  }
  const reason = LEGACY_SOURCE_REFUSALS.find((known) => known === data.reason)
  const artifact = LEGACY_SOURCE_ARTIFACTS.find(
    (known) => 'artifact' in data && known === data.artifact
  )
  return reason
    ? {
        version: 2,
        phase: 'refused',
        policy: LEGACY_SOURCE_REFUSAL_POLICY,
        proof: data.proof,
        store: data.store,
        reason,
        ...(artifact ? { artifact } : {})
      }
    : null
}

const COUNT = z.number().int().nonnegative()
const LEGACY_PROOF_COUNTS = z.object({
  chats: COUNT,
  alreadyConverted: COUNT,
  newlyConverted: COUNT,
  deletedHere: COUNT,
  drafts: COUNT,
  originals: COUNT,
  copies: COUNT
})

function decodeCounts(value: unknown): { counts?: LegacyProofCounts } {
  const counts = LEGACY_PROOF_COUNTS.safeParse(value)
  return counts.success ? { counts: counts.data } : {}
}
