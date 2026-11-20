import {
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
  converted: number
  notConverted: number
  originals: number
  copies: number
}

/**
 * The proof of this original into this store finished, and the policy held deletion. A later
 * launch reads this instead of walking again; deletion, once allowed, resumes at the copies.
 */
export type LegacySourceHeld = {
  version: 2
  phase: 'held'
  layout: typeof LEGACY_PROOF_LAYOUT
  proof: string
  store: string
  counts: LegacyProofCounts
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
  /** A shape builds left behind that the refusal saw; for reporting only. */
  artifact?: LegacySourceArtifact
}

/**
 * 2: progress and completion this build saves while deletion is held for a remote policy. Builds
 * before it resume only layout 1, so none of them carries this build's progress past the checks
 * it made; each proves from the start under its own rules.
 */
export const LEGACY_PROOF_LAYOUT = 2
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
  return reason
    ? {
        version: 2,
        phase: 'refused',
        policy: LEGACY_SOURCE_REFUSAL_POLICY,
        proof: data.proof,
        store: data.store,
        reason,
        ...('artifact' in data &&
        (data.artifact === 'source_json' || data.artifact === 'pause_table')
          ? { artifact: data.artifact }
          : {})
      }
    : null
}

function decodeCounts(value: unknown): { counts?: LegacyProofCounts } {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const read = (name: keyof LegacyProofCounts): number | null => {
    const count: unknown = name in value ? Reflect.get(value, name) : undefined
    return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null
  }
  const counts = {
    chats: read('chats'),
    converted: read('converted'),
    notConverted: read('notConverted'),
    originals: read('originals'),
    copies: read('copies')
  }
  return Object.values(counts).every((count) => count !== null)
    ? { counts: counts as LegacyProofCounts }
    : {}
}
