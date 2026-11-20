import {
  LEGACY_SOURCE_REFUSALS,
  type LegacySourceRefusalReason
} from './journal-legacy-retention-error'

/**
 * Saved beside the copy receipt. Builds from before on-update retirement read the v1 key, so this
 * one never collides with their grace rows; those are left untouched.
 */
export const JOURNAL_LEGACY_RETIREMENT = 'journal.legacy-retirement.v2'
export const LEGACY_SOURCE_REFUSAL_POLICY = 3
/**
 * Which inventory check a refusal saw. 2 accepts shapes earlier builds left behind; an inventory
 * or recovery refusal saved below it is proven once more, and one saved at or above it stands. A
 * separate field, not a policy bump, so earlier builds still honour this build's refusals.
 */
export const LEGACY_SOURCE_INVENTORY = 2
const RECHECKED_WITHOUT_INVENTORY: readonly LegacySourceRefusalReason[] = [
  'source-inventory',
  'source-recovery'
]
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
}

/** A proof that failed for a reason the frozen original can't outgrow, keyed to that original. */
export type LegacySourceRefusal = {
  version: 2
  phase: 'refused'
  policy: typeof LEGACY_SOURCE_REFUSAL_POLICY
  proof: string
  store: string
  reason: LegacySourceRefusalReason
  inventory?: number
}

/** The proof's page layout; progress saved under another is walked again from the start. */
export const LEGACY_PROOF_LAYOUT = 1
/**
 * Progress and retiring records for an original carrying a shape only this build accepts. Builds
 * before it check inventory on the first page alone, so they must never resume such a proof.
 */
export const LEGACY_PROOF_HISTORICAL_LAYOUT = 2
export type LegacyProofLayout = typeof LEGACY_PROOF_LAYOUT | typeof LEGACY_PROOF_HISTORICAL_LAYOUT

export function isLegacyProofLayout(value: unknown): value is LegacyProofLayout {
  return value === LEGACY_PROOF_LAYOUT || value === LEGACY_PROOF_HISTORICAL_LAYOUT
}
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
  layout: LegacyProofLayout
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
  layout: LegacyProofLayout
  proof: string
  store: string
  cursor: { table: number; after: string | null; epoch?: string }
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
    !isLegacyProofLayout(data.layout) ||
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
    layout: data.layout,
    proof: data.proof,
    store: data.store,
    cursor: { table, after, ...(epoch === undefined ? {} : { epoch }) }
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
  const inventory =
    'inventory' in data &&
    typeof data.inventory === 'number' &&
    data.inventory >= LEGACY_SOURCE_INVENTORY
      ? data.inventory
      : undefined
  return reason && (inventory || !RECHECKED_WITHOUT_INVENTORY.includes(reason))
    ? {
        version: 2,
        phase: 'refused',
        policy: LEGACY_SOURCE_REFUSAL_POLICY,
        proof: data.proof,
        store: data.store,
        reason,
        ...(inventory ? { inventory } : {})
      }
    : null
}
