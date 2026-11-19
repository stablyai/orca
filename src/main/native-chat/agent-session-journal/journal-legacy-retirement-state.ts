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
}

/**
 * The commit that makes every converted row durable before the original is unlinked. It names
 * the original it retires; nothing reads it to decide anything.
 */
export type LegacySourceRetiring = {
  version: 2
  phase: 'retiring'
  proof: string
  store: string
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
        reason
      }
    : null
}
