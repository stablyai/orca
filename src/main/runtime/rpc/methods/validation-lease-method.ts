import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { requireLeaseOwnerAuthority } from '../../orchestration/control-plane/lease-owner-authority'
import {
  acquireValidationLease,
  assertMutationAllowed,
  releaseValidationLease
} from '../../orchestration/control-plane/validation-lease'
import { resolveValidationScopeKey } from '../../orchestration/control-plane/validation-scope'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import {
  clearSentinelFor,
  requireRunId,
  requireTask,
  ValidationLeaseParams,
  writeSentinelFor
} from './validation-lease-sentinel'

/** The validation lease: the only thing that may declare a workspace off limits
 *  while a gate runs in it.
 *
 *  Two corrections live here. The scope is derived from the OWNER DISPATCH's own
 *  worktree rather than from whichever terminal happens to be calling — a scope
 *  resolved from the coordinator can name a different workspace than the one the
 *  work runs in, and a Run-scoped fallback names one the pre-tool hook cannot
 *  check at all. And a lease is not reported acquired until its offline fence
 *  exists, because a caller told "acquired" proceeds believing the tree is
 *  guarded.
 */
export const VALIDATION_LEASE_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.validationLease',
  params: ValidationLeaseParams,
  handler: async (params, { runtime }) => {
    const db = runtime.getOrchestrationDb()
    const runId = params.run ?? requireRunId(runtime, params.from)
    const store = new ControlPlaneStore(db)
    const nowMs = Date.now()

    if (params.action === 'check') {
      // Why the Dispatch when one is named: acquire binds the scope to the owner
      // Dispatch's own worktree, so a check resolved from the calling terminal
      // could answer about a different workspace than the one actually leased.
      const scopeKey = params.dispatch
        ? requireLeaseOwnerAuthority(db, {
            dispatchId: params.dispatch,
            runId,
            taskId: requireTask(params.task, 'check')
          }).scopeKey
        : await resolveValidationScopeKey({ runtime, terminalHandle: params.from, runId })
      return { scopeKey, guard: assertMutationAllowed(store, { scopeKey, nowMs }) }
    }

    if (!params.dispatch) {
      throw new OrchestrationError(
        'invalid_argument',
        `${params.action} requires --dispatch: a lease is owned by the Dispatch whose workspace it protects.`
      )
    }
    // Exact placement, not merely the same Run: a Dispatch in another worktree
    // must not be able to claim or clear the protection on this one.
    const authority = requireLeaseOwnerAuthority(db, {
      dispatchId: params.dispatch,
      runId,
      taskId: requireTask(params.task, params.action)
    })

    if (params.action === 'release') {
      if (!params.leaseId) {
        throw new OrchestrationError('invalid_argument', 'release requires --lease-id.')
      }
      // Why the owner too: the lease id appears in receipts and logs, so id
      // alone would let anyone who read one release someone else's lease.
      const released = releaseValidationLease(store, {
        scopeKey: authority.scopeKey,
        leaseId: params.leaseId,
        nowMs,
        owner: params.dispatch
      })
      if (released.released) {
        clearSentinelFor(authority.worktreeId)
      }
      return { scopeKey: authority.scopeKey, authority, ...released }
    }

    const idempotencyKey =
      params.idempotencyKey ?? `${params.dispatch}:${params.leaseId ?? 'default'}`
    let acquisition
    try {
      acquisition = acquireValidationLease(store, {
        scopeKey: authority.scopeKey,
        leaseId: params.leaseId ?? `lease_${params.dispatch}`,
        owner: params.dispatch,
        idempotencyKey,
        nowMs,
        ttlMs: params.ttlMs,
        // Why a file as well as the live gate: if Orca is unreachable the hook
        // has nothing to ask, and on a worktree with a gate running that must
        // read as deny. Established INSIDE the transaction so the row and the
        // marker become true together — a lease told "acquired" whose offline
        // half does not exist is worse than a refused one.
        establishFence: (lease) =>
          writeSentinelFor(authority.worktreeId, lease.leaseId, Date.parse(lease.expiresAt))
      })
    } catch (error) {
      // The row was rolled back with the marker, so nothing is half-armed. Report
      // it as its own condition rather than as whatever the filesystem said.
      throw new OrchestrationError(
        'fence_sentinel_unavailable',
        `No validation lease was taken: its offline fence could not be established. ${String(error)}`
      )
    }
    if (!acquisition.ok) {
      throw new OrchestrationError(
        acquisition.code,
        acquisition.reason,
        // Both failure codes carry the lease that is actually in force: one
        // because someone else holds it, the other because this retry could not
        // re-arm the offline half of a lease that is still held.
        acquisition.code === 'invalid_ttl' ? undefined : { lease: acquisition.lease }
      )
    }
    return { scopeKey: authority.scopeKey, authority, ...acquisition }
  }
})
