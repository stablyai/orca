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

// [default, min, max]: the reviewed values are the loosest, so a remote policy can only tighten.
const THRESHOLD_BOUNDS = {
  rollouts: {
    minSharedPasses: [1, 1, 1000]
  },
  databases: {
    minSharedDays: [14, 14, 365],
    minSharedPasses: [5, 5, 1000],
    maxSinceLastSharedDays: [30, 1, 30],
    minUnchangedDays: [14, 14, 365]
  }
} as const satisfies Record<CodexHistoryCleanupKind, Record<string, readonly number[]>>

export type CodexHistoryCleanupThresholds<K extends CodexHistoryCleanupKind> = {
  [T in keyof (typeof THRESHOLD_BOUNDS)[K]]: number
}

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

export function codexHistoryCleanupThresholds<K extends CodexHistoryCleanupKind>(
  policy: CodexHistoryCleanupPolicy | null,
  kind: K
): CodexHistoryCleanupThresholds<K> {
  const remote = policy?.kinds[kind]?.thresholds ?? {}
  const bounds: Record<string, readonly number[]> = THRESHOLD_BOUNDS[kind]
  return Object.fromEntries(
    Object.entries(bounds).map(([name, [fallback, min, max]]) => {
      const value = remote[name]
      return [
        name,
        typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
      ]
    })
  ) as CodexHistoryCleanupThresholds<K>
}

// Fixed salt: widening the permille only adds installs, never swaps them.
export function codexHistoryCleanupBucket(installId: string): number {
  return (
    createHash('sha256').update(`codex-history-cleanup:${installId}`).digest().readUInt32BE(0) %
    1000
  )
}

/**
 * This install's mode for `kind`. `off` holds from the newest policy known, the cache included, so
 * a failed download never undoes a kill switch; `enforce` only from a download that is itself the
 * policy in force (not one the cache outranked), fetched within the day.
 */
export function effectiveCodexHistoryCleanupMode(args: {
  kind: CodexHistoryCleanupKind
  fetched: {
    policy: CodexHistoryCleanupPolicy
    downloaded: CodexHistoryCleanupPolicy
    at: number
  } | null
  cached: CodexHistoryCleanupPolicy | null
  now: number
  platform: NodeJS.Platform
  installId: string | undefined
}): CodexHistoryCleanupMode {
  const known = args.fetched?.policy ?? args.cached
  if (known?.kinds[args.kind]?.mode === 'off') {
    return 'off'
  }
  const fetched = args.fetched
  const rule = fetched?.policy.kinds[args.kind]
  if (
    !fetched ||
    fetched.downloaded.revision < fetched.policy.revision ||
    rule?.mode !== 'enforce'
  ) {
    return 'report'
  }
  const platformAllowed = rule.platforms === undefined || rule.platforms.includes(args.platform)
  return platformAllowed &&
    args.now - fetched.at <= CLEANUP_ENFORCE_FRESH_MS &&
    Boolean(args.installId) &&
    codexHistoryCleanupBucket(args.installId!) < clamp(rule.enforcePermille, 0, 1000)
    ? 'enforce'
    : 'report'
}
