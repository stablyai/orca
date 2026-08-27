import type { ControlPlaneStore, ValidationLeaseRow } from './control-plane-store'

/** B9 — a runtime-owned lease so an in-flight test/preflight cannot be
 *  contaminated by source mutation in the same worktree.
 *
 *  State machine (one row per scope key, the scope key being the worktree):
 *    trigger              immediate state  writer                 next state
 *    -----------------------------------------------------------------------
 *    acquire (free)       held             acquireValidationLease released | expired
 *    acquire (same idem)  held             acquireValidationLease held (no-op)
 *    acquire (other idem) held             acquireValidationLease rejected
 *    release              released         releaseValidationLease free
 *    expiry passes        expired          the clock              free
 *  Lock / serialization: SQLite PRIMARY KEY(scope_key) is the lock; the caller
 *  wraps acquire in the same IMMEDIATE transaction as the work it guards.
 *  Ownership: `owner` is the Dispatch that holds it; only that owner may
 *  release. Idempotency key: a retried acquire with the same key returns the
 *  same lease instead of a second one. Crash recovery: `expires_at` reclaims a
 *  lease whose owner died, so a crashed validation never wedges the worktree.
 */

export const DEFAULT_VALIDATION_LEASE_TTL_MS = 30 * 60 * 1000

export type ValidationLease = {
  scopeKey: string
  leaseId: string
  owner: string
  idempotencyKey: string
  acquiredAt: string
  expiresAt: string
}

export type LeaseAcquisition =
  | { ok: true; lease: ValidationLease; duplicate: boolean; reclaimed: boolean }
  | {
      ok: false
      code: 'held_by_other_owner'
      lease: ValidationLease
      reason: string
    }

function toLease(row: ValidationLeaseRow): ValidationLease {
  return {
    scopeKey: row.scope_key,
    leaseId: row.lease_id,
    owner: row.owner,
    idempotencyKey: row.idempotency_key,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at
  }
}

function isActive(row: ValidationLeaseRow, nowMs: number): boolean {
  if (row.released_at) {
    return false
  }
  const expires = Date.parse(row.expires_at)
  return !Number.isFinite(expires) || expires > nowMs
}

export function acquireValidationLease(
  store: ControlPlaneStore,
  args: {
    scopeKey: string
    leaseId: string
    owner: string
    idempotencyKey: string
    nowMs: number
    ttlMs?: number
  }
): LeaseAcquisition {
  const existing = store.getValidationLease(args.scopeKey)
  const ttl = args.ttlMs ?? DEFAULT_VALIDATION_LEASE_TTL_MS
  if (existing && isActive(existing, args.nowMs)) {
    if (existing.idempotency_key === args.idempotencyKey) {
      return { ok: true, lease: toLease(existing), duplicate: true, reclaimed: false }
    }
    return {
      ok: false,
      code: 'held_by_other_owner',
      lease: toLease(existing),
      reason: `Validation lease on ${args.scopeKey} is held by ${existing.owner} until ${existing.expires_at}.`
    }
  }
  const row: ValidationLeaseRow = {
    scope_key: args.scopeKey,
    lease_id: args.leaseId,
    owner: args.owner,
    idempotency_key: args.idempotencyKey,
    acquired_at: new Date(args.nowMs).toISOString(),
    expires_at: new Date(args.nowMs + ttl).toISOString(),
    released_at: null
  }
  store.putValidationLease(row)
  return {
    ok: true,
    lease: toLease(row),
    duplicate: false,
    reclaimed: Boolean(existing) && !isActive(existing as ValidationLeaseRow, args.nowMs)
  }
}

export function releaseValidationLease(
  store: ControlPlaneStore,
  args: { scopeKey: string; leaseId: string; nowMs: number; owner?: string }
): { released: boolean } {
  const existing = store.getValidationLease(args.scopeKey)
  // Why owner as well as lease id: the lease id travels in receipts and logs,
  // so id alone would let any reader of a receipt release someone else's lease.
  if (args.owner !== undefined && existing?.owner !== args.owner) {
    return { released: false }
  }
  if (!existing || existing.lease_id !== args.leaseId || existing.released_at) {
    // Why not an error: a duplicate release after a crash-recovery retry is the
    // expected shape, and it must stay a no-op.
    return { released: false }
  }
  store.releaseValidationLease(args.scopeKey, args.leaseId, new Date(args.nowMs).toISOString())
  return { released: true }
}

export type MutationGuard =
  | { allowed: true }
  | {
      allowed: false
      code: 'validation_in_progress'
      lease: ValidationLease
      /** The only two legal moves while a lease is held. */
      remedies: readonly ['wait_for_lease_completion', 'use_separate_worktree']
      reason: string
    }

/** Blocks a source mutation while a validation lease is active on the same
 *  worktree. A baseline reproduction must either wait or run in its own
 *  worktree/process — it must never edit under a running gate. */
export function assertMutationAllowed(
  store: ControlPlaneStore,
  args: { scopeKey: string; nowMs: number; holderLeaseId?: string }
): MutationGuard {
  const existing = store.getValidationLease(args.scopeKey)
  if (!existing || !isActive(existing, args.nowMs)) {
    return { allowed: true }
  }
  if (args.holderLeaseId && existing.lease_id === args.holderLeaseId) {
    // Why: the lease holder itself is the process running the gate.
    return { allowed: true }
  }
  return {
    allowed: false,
    code: 'validation_in_progress',
    lease: toLease(existing),
    remedies: ['wait_for_lease_completion', 'use_separate_worktree'],
    reason: `Validation lease ${existing.lease_id} is active on ${args.scopeKey}; source mutation would contaminate it.`
  }
}
