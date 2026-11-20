import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Remote staging for deleting the old chat journal once the chat store provably holds it: `off`
 * runs no proof and deletes nothing, `report` proves and keeps the file, `enforce` deletes for the
 * installs in its cohort. Anything missing, stale or unreadable reads as `report`; only a fresh
 * download of the newest revision can enforce, and the newest known `off` always holds.
 */
export const JOURNAL_RETIREMENT_POLICY_MAX_BYTES = 16 * 1024
export const JOURNAL_RETIREMENT_ENFORCE_FRESH_MS = 24 * 60 * 60 * 1000

export type JournalRetirementMode = 'off' | 'report' | 'enforce'

// Not strict, and each field falls back on its own: a field added later never drops the policy.
const JournalRetirementPolicySchema = z.object({
  version: z.literal(1),
  /** Monotonic: a lower or equal revision never replaces the cached one. */
  revision: z.number().int().positive(),
  mode: z.enum(['off', 'report', 'enforce']).catch('report'),
  enforcePermille: z.number().catch(0),
  platforms: z.array(z.unknown()).optional().catch([])
})

export type JournalRetirementPolicy = z.infer<typeof JournalRetirementPolicySchema>

export function parseJournalRetirementPolicy(
  text: string
): { ok: true; policy: JournalRetirementPolicy } | { ok: false; error: string } {
  if (new TextEncoder().encode(text).byteLength > JOURNAL_RETIREMENT_POLICY_MAX_BYTES) {
    return { ok: false, error: `larger than ${JOURNAL_RETIREMENT_POLICY_MAX_BYTES} bytes` }
  }
  try {
    return { ok: true, policy: JournalRetirementPolicySchema.parse(JSON.parse(text)) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Fixed salt: widening the permille only adds installs, never swaps them.
export function journalRetirementBucket(installId: string): number {
  return (
    createHash('sha256').update(`journal-retirement:${installId}`).digest().readUInt32BE(0) % 1000
  )
}

export function newestJournalRetirementPolicy(
  fetched: { policy: JournalRetirementPolicy } | null,
  newestKnown: JournalRetirementPolicy | null
): JournalRetirementPolicy | null {
  const fetchedPolicy = fetched?.policy ?? null
  return fetchedPolicy && (!newestKnown || fetchedPolicy.revision >= newestKnown.revision)
    ? fetchedPolicy
    : newestKnown
}

/** This install's mode now, and the revision it comes from (0 with no policy known). */
export function effectiveJournalRetirementMode(args: {
  fetched: {
    policy: JournalRetirementPolicy
    downloaded: JournalRetirementPolicy
    at: number
  } | null
  /** The newest policy known, downloaded or cached, even after a failed download. */
  newestKnown: JournalRetirementPolicy | null
  now: number
  platform: NodeJS.Platform
  installId: string | undefined
}): { mode: JournalRetirementMode; revision: number } {
  const known = newestJournalRetirementPolicy(args.fetched, args.newestKnown)
  const revision = known?.revision ?? 0
  // The download itself counts only when it is the newest revision known.
  const rule =
    args.fetched && args.fetched.downloaded.revision === known?.revision
      ? args.fetched.downloaded
      : null
  if (known?.mode === 'off' || rule?.mode === 'off') {
    return { mode: 'off', revision }
  }
  if (!args.fetched || !rule || rule.mode !== 'enforce') {
    return { mode: 'report', revision }
  }
  const platformAllowed = rule.platforms === undefined || rule.platforms.includes(args.platform)
  const enforce =
    platformAllowed &&
    args.now - args.fetched.at <= JOURNAL_RETIREMENT_ENFORCE_FRESH_MS &&
    !!args.installId &&
    journalRetirementBucket(args.installId) <
      Math.min(1000, Math.max(0, Math.round(rule.enforcePermille)))
  return { mode: enforce ? 'enforce' : 'report', revision }
}
