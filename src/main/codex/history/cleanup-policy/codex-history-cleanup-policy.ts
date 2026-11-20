import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Remote staging for deleting what history sharing left behind, per kind: `off` does no file work,
 * `report` runs every check but deletes nothing, `enforce` deletes for the installs in its cohort.
 * Anything missing, stale or unreadable reads as `report`; only a fresh download can enforce.
 */
export const CODEX_HISTORY_CLEANUP_POLICY_MAX_BYTES = 16 * 1024
export const CLEANUP_ENFORCE_FRESH_MS = 24 * 60 * 60 * 1000

export type CodexHistoryCleanupKind = 'rollouts' | 'databases'
export type CodexHistoryCleanupMode = 'off' | 'report' | 'enforce'

type Bound = readonly [fallback: number, min: number, max: number]

// The reviewed values are the loosest, so a remote policy can only tighten them.
const ROLLOUT_BOUNDS = {
  minSharedPasses: [1, 1, 1000]
} as const satisfies Record<string, Bound>
const DATABASE_BOUNDS = {
  minSharedDays: [14, 14, 365],
  minSharedPasses: [5, 5, 1000],
  maxSinceLastSharedDays: [30, 1, 30],
  minUnchangedDays: [14, 14, 365]
} as const satisfies Record<string, Bound>

type AllThresholds = {
  rollouts: { [T in keyof typeof ROLLOUT_BOUNDS]: number }
  databases: { [T in keyof typeof DATABASE_BOUNDS]: number }
}
export type CodexHistoryCleanupThresholds<K extends CodexHistoryCleanupKind> = AllThresholds[K]

// Not strict, and each field falls back on its own: a field added later never drops the policy.
const KindPolicySchema = z.object({
  mode: z.enum(['off', 'report', 'enforce']).catch('report'),
  enforcePermille: z.number().catch(0),
  platforms: z.array(z.unknown()).optional().catch([]),
  thresholds: z.record(z.string(), z.unknown()).optional().catch(undefined)
})

const CodexHistoryCleanupPolicySchema = z.object({
  version: z.literal(1),
  /** Monotonic: a lower or equal revision never replaces the cached one. */
  revision: z.number().int().positive(),
  kinds: z
    .object({
      rollouts: KindPolicySchema.optional().catch(undefined),
      databases: KindPolicySchema.optional().catch(undefined)
    })
    .catch({})
})

export type CodexHistoryCleanupPolicy = z.infer<typeof CodexHistoryCleanupPolicySchema>

export function parseCodexHistoryCleanupPolicy(
  text: string
): { ok: true; policy: CodexHistoryCleanupPolicy } | { ok: false; error: string } {
  if (new TextEncoder().encode(text).byteLength > CODEX_HISTORY_CLEANUP_POLICY_MAX_BYTES) {
    return { ok: false, error: `larger than ${CODEX_HISTORY_CLEANUP_POLICY_MAX_BYTES} bytes` }
  }
  try {
    return { ok: true, policy: CodexHistoryCleanupPolicySchema.parse(JSON.parse(text)) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function threshold(
  remote: Record<string, unknown> | undefined,
  name: string,
  [fallback, min, max]: Bound
): number {
  const value = remote?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

export function codexHistoryCleanupThresholds(
  policy: CodexHistoryCleanupPolicy | null
): AllThresholds {
  const rollouts = policy?.kinds.rollouts?.thresholds
  const databases = policy?.kinds.databases?.thresholds
  return {
    rollouts: {
      minSharedPasses: threshold(rollouts, 'minSharedPasses', ROLLOUT_BOUNDS.minSharedPasses)
    },
    databases: {
      minSharedDays: threshold(databases, 'minSharedDays', DATABASE_BOUNDS.minSharedDays),
      minSharedPasses: threshold(databases, 'minSharedPasses', DATABASE_BOUNDS.minSharedPasses),
      maxSinceLastSharedDays: threshold(
        databases,
        'maxSinceLastSharedDays',
        DATABASE_BOUNDS.maxSinceLastSharedDays
      ),
      minUnchangedDays: threshold(databases, 'minUnchangedDays', DATABASE_BOUNDS.minUnchangedDays)
    }
  }
}

// Fixed salt: widening the permille only adds installs, never swaps them.
export function codexHistoryCleanupBucket(installId: string): number {
  return (
    createHash('sha256').update(`codex-history-cleanup:${installId}`).digest().readUInt32BE(0) %
    1000
  )
}

/**
 * This install's mode for `kind`. `off` holds from the newest policy known, so a failed download
 * or cache write never undoes a kill switch. `enforce` comes only from a download of the newest
 * revision known, fetched within the day, and only by its own rule.
 */
export function effectiveCodexHistoryCleanupMode(args: {
  kind: CodexHistoryCleanupKind
  fetched: {
    policy: CodexHistoryCleanupPolicy
    downloaded: CodexHistoryCleanupPolicy
    at: number
  } | null
  /** The newest policy known, downloaded or cached, even after a failed download. */
  newestKnown: CodexHistoryCleanupPolicy | null
  now: number
  platform: NodeJS.Platform
  installId: string | undefined
}): CodexHistoryCleanupMode {
  const known = newestCodexHistoryCleanupPolicy(args.fetched, args.newestKnown)
  const rule = authoritativeDownload(args.fetched, known)?.kinds[args.kind]
  if (known?.kinds[args.kind]?.mode === 'off' || rule?.mode === 'off') {
    return 'off'
  }
  if (!args.fetched || !rule || rule.mode !== 'enforce') {
    return 'report'
  }
  const platformAllowed = rule.platforms === undefined || rule.platforms.includes(args.platform)
  return platformAllowed &&
    args.now - args.fetched.at <= CLEANUP_ENFORCE_FRESH_MS &&
    args.installId &&
    codexHistoryCleanupBucket(args.installId) < clamp(rule.enforcePermille, 0, 1000)
    ? 'enforce'
    : 'report'
}

/** The newest policy known: the one in force after the last download, or `newestKnown`. */
export function newestCodexHistoryCleanupPolicy(
  fetched: { policy: CodexHistoryCleanupPolicy } | null,
  newestKnown: CodexHistoryCleanupPolicy | null
): CodexHistoryCleanupPolicy | null {
  const fetchedPolicy = fetched?.policy ?? null
  return fetchedPolicy && (!newestKnown || fetchedPolicy.revision >= newestKnown.revision)
    ? fetchedPolicy
    : newestKnown
}

/** The download itself, when it is the newest revision known; null otherwise. */
export function authoritativeDownload(
  fetched: { downloaded: CodexHistoryCleanupPolicy } | null,
  known: CodexHistoryCleanupPolicy | null
): CodexHistoryCleanupPolicy | null {
  return fetched && fetched.downloaded.revision === known?.revision ? fetched.downloaded : null
}
