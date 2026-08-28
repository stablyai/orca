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
      /** A retry of an already-held lease whose offline fence could not be
       *  re-established. The existing row is deliberately left ACTIVE — tearing
       *  down a protection already in force because a retry's bookkeeping failed
       *  would unfence a tree mid-gate — but the retry itself must not read as
       *  acquired, or a caller proceeds certified on a half-armed fence. */
      ok: false
      code: 'fence_refresh_failed'
      lease: ValidationLease
      reason: string
    }
  | {
      ok: false
      code: 'held_by_other_owner'
      lease: ValidationLease
      reason: string
    }
  | { ok: false; code: 'invalid_ttl'; reason: string }

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
    /** Runs INSIDE the acquisition transaction, before the row is committed.
     *
     *  Why inside: the durable offline fence and the database row have to become
     *  true together. Committing first left a window where a crash — or a failed
     *  write — produced an active lease with no marker, so a disconnected worker
     *  saw an unfenced workspace the database said was protected. Throwing here
     *  rolls the row back, and the reverse order can only ever over-deny until
     *  the marker expires, which is the safe direction. */
    establishFence?: (lease: ValidationLease) => void
  }
): LeaseAcquisition {
  const ttl = args.ttlMs ?? DEFAULT_VALIDATION_LEASE_TTL_MS
  if (!Number.isFinite(ttl) || ttl <= 0) {
    // Why reject rather than clamp: a zero or negative TTL mints a lease that is
    // already expired, which reads as "protected" to the acquirer and as "free"
    // to everyone else.
    return {
      ok: false,
      code: 'invalid_ttl',
      reason: `A validation lease TTL must be a positive number of milliseconds; received ${String(args.ttlMs)}.`
    }
  }
  // Why the transaction: read-then-write is a TOCTOU window. Two acquirers can
  // both see the scope free and the second silently overwrites the first's
  // ownership. BEGIN IMMEDIATE takes the write lock for the whole decision.
  store.db.exec('BEGIN IMMEDIATE')
  try {
    return acquireInsideTransaction(store, args, ttl)
  } catch (error) {
    store.db.exec('ROLLBACK')
    throw error
  }
}

function acquireInsideTransaction(
  store: ControlPlaneStore,
  args: {
    scopeKey: string
    leaseId: string
    owner: string
    idempotencyKey: string
    nowMs: number
    establishFence?: (lease: ValidationLease) => void
  },
  ttl: number
): LeaseAcquisition {
  const existing = store.getValidationLease(args.scopeKey)
  if (existing && isActive(existing, args.nowMs)) {
    store.db.exec('COMMIT')
    // Why all three and not the key alone: an idempotency key is caller-chosen,
    // so a DIFFERENT Dispatch that happened to reuse one was handed the lease
    // someone else was holding. A replay is the SAME acquirer asking again.
    if (
      existing.idempotency_key === args.idempotencyKey &&
      existing.owner === args.owner &&
      existing.lease_id === args.leaseId
    ) {
      const lease = toLease(existing)
      // A retry of an already-held lease. Refresh its marker if we can, but never
      // release: the protection is already in force and tearing it down because
      // a retry's bookkeeping failed would unfence a tree mid-gate.
      try {
        args.establishFence?.(lease)
      } catch (error) {
        return {
          ok: false,
          code: 'fence_refresh_failed',
          lease,
          reason: `Validation lease ${lease.leaseId} is still held on ${args.scopeKey}, but its offline fence could not be re-established, so this retry is not certified. ${String(error)}`
        }
      }
      return { ok: true, lease, duplicate: true, reclaimed: false }
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
  // Before COMMIT, so a marker failure rolls the row back and no active lease
  // can exist without its offline half.
  args.establishFence?.(toLease(row))
  store.db.exec('COMMIT')
  return {
    ok: true,
    lease: toLease(row),
    duplicate: false,
    reclaimed: Boolean(existing) && !isActive(existing as ValidationLeaseRow, args.nowMs)
  }
}

export function releaseValidationLease(
  store: ControlPlaneStore,
  args: { scopeKey: string; leaseId: string; nowMs: number; owner: string }
): { released: boolean } {
  const existing = store.getValidationLease(args.scopeKey)
  // Why owner as well as lease id, and why REQUIRED: the lease id travels in
  // receipts and logs, so id alone lets any reader of a receipt release someone
  // else's lease. An optional owner meant a caller that simply omitted it got
  // exactly that power, which is the same hole with an extra step.
  if (!args.owner || existing?.owner !== args.owner) {
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
/** Blocks a source mutation while a validation lease is active on the same
 *  worktree — INCLUDING the holder's own.
 *
 *  There is deliberately no holder exemption. Owning a lease is authority to
 *  RELEASE it, never authority to mutate under it: the holder is precisely the
 *  Dispatch whose gate child process is reading the tree right now, so its own
 *  edits are the contamination the lease exists to prevent. */
export function assertMutationAllowed(
  store: ControlPlaneStore,
  args: { scopeKey: string; nowMs: number }
): MutationGuard {
  const existing = store.getValidationLease(args.scopeKey)
  if (!existing || !isActive(existing, args.nowMs)) {
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
