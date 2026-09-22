// Why: old idempotent hosts omit policy, so preserve today's effective replay window.
export const WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS = 60_000

// Why: a client must not trust a host advertisement beyond its tested ceiling.
export const WORKTREE_CREATE_DEDUPE_TTL_CLIENT_CEILING_MS = 60_000

// Why: the replay still has to reach the host before its dedupe record expires.
const WORKTREE_CREATE_REPLAY_FLIGHT_MARGIN_MS = 10_000

export type WorktreeCreateIdempotencySupport = {
  dedupeTtlMs: number
}

export type WorktreeCreateIdempotencyProbe =
  | WorktreeCreateIdempotencySupport
  | false
  | Promise<WorktreeCreateIdempotencySupport | false>

export function resolveWorktreeCreateIdempotencySupport(
  advertisedDedupeTtlMs: unknown
): WorktreeCreateIdempotencySupport {
  if (advertisedDedupeTtlMs === undefined) {
    return { dedupeTtlMs: 0 }
  }
  if (
    typeof advertisedDedupeTtlMs !== 'number' ||
    !Number.isSafeInteger(advertisedDedupeTtlMs) ||
    advertisedDedupeTtlMs < 0
  ) {
    // Truthy support preserves immediate cutover retries while disabling ambiguous replay.
    return { dedupeTtlMs: 0 }
  }
  return {
    dedupeTtlMs: Math.min(advertisedDedupeTtlMs, WORKTREE_CREATE_DEDUPE_TTL_CLIENT_CEILING_MS)
  }
}

export function getWorktreeCreateReplayWindowMs(support: WorktreeCreateIdempotencySupport): number {
  return Math.max(0, support.dedupeTtlMs - WORKTREE_CREATE_REPLAY_FLIGHT_MARGIN_MS)
}
