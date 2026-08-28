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
  handler: async (
    params,
    { runtime, orchestrationCompatibilityEvidence, orchestrationCompatibilityCallerAuthority }
  ) => {
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

    const caller =
      orchestrationCompatibilityCallerAuthority ??
      runtime.verifyOrchestrationCompatibilityCaller(orchestrationCompatibilityEvidence)
    if (
      !params.from ||
      !caller ||
      caller.terminalHandle !== params.from ||
      caller.terminalHandle !== authority.ownerHandle ||
      caller.paneKey !== authority.ownerPaneKey ||
      caller.processIncarnation !== authority.processIncarnation ||
      caller.launchTokenHash !== authority.launchTokenHash
    ) {
      throw new OrchestrationError(
        'validation_lease_owner_mismatch',
        `Validation lease ${params.action} must come from the exact live process assigned to Dispatch ${params.dispatch}.`
      )
    }

    const runtimeId = runtime.getStatus().runtimeId
    const buildId = runtime.getBuildIdentity().id

    if (params.action === 'release') {
      if (!params.leaseId) {
        throw new OrchestrationError('invalid_argument', 'release requires --lease-id.')
      }
      const recorded = store.getValidationLeaseAuthority(authority.scopeKey, params.leaseId)
      const currentLease = store.getValidationLease(authority.scopeKey)
      if (
        !recorded ||
        recorded.run_id !== authority.runId ||
        recorded.outcome_id !== authority.outcomeId ||
        recorded.task_id !== authority.taskId ||
        recorded.dispatch_id !== authority.dispatchId ||
        recorded.worktree_id !== authority.worktreeId ||
        recorded.owner_handle !== caller.terminalHandle ||
        recorded.owner_pane_key !== caller.paneKey ||
        recorded.process_incarnation !== caller.processIncarnation ||
        recorded.launch_token_hash !== caller.launchTokenHash ||
        recorded.runtime_id !== runtimeId ||
        recorded.build_id !== buildId
      ) {
        throw new OrchestrationError(
          'validation_lease_owner_mismatch',
          `Validation lease ${params.leaseId} is not bound to this exact Dispatch process and runtime build.`
        )
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
        clearSentinelFor(authority.worktreeId, {
          leaseId: params.leaseId,
          acquiredAt: currentLease?.acquired_at ?? ''
        })
      }
      return { scopeKey: authority.scopeKey, authority, ...released }
    }

    const idempotencyKey =
      params.idempotencyKey ?? `${params.dispatch}:${params.leaseId ?? 'default'}`
    const leaseId = params.leaseId ?? `lease_${params.dispatch}`
    const existingAuthority = store.getValidationLeaseAuthority(authority.scopeKey, leaseId)
    if (
      existingAuthority &&
      (existingAuthority.run_id !== authority.runId ||
        existingAuthority.outcome_id !== authority.outcomeId ||
        existingAuthority.task_id !== authority.taskId ||
        existingAuthority.dispatch_id !== authority.dispatchId ||
        existingAuthority.worktree_id !== authority.worktreeId ||
        existingAuthority.owner_handle !== caller.terminalHandle ||
        existingAuthority.owner_pane_key !== caller.paneKey ||
        existingAuthority.process_incarnation !== caller.processIncarnation ||
        existingAuthority.launch_token_hash !== caller.launchTokenHash ||
        existingAuthority.runtime_id !== runtimeId ||
        existingAuthority.build_id !== buildId)
    ) {
      throw new OrchestrationError(
        'validation_lease_owner_mismatch',
        `Validation lease ${leaseId} was created by a different process or runtime build.`
      )
    }
    let acquisition
    try {
      acquisition = acquireValidationLease(store, {
        scopeKey: authority.scopeKey,
        leaseId,
        owner: params.dispatch,
        idempotencyKey,
        nowMs,
        ttlMs: params.ttlMs,
        // Why a file as well as the live gate: if Orca is unreachable the hook
        // has nothing to ask, and on a worktree with a gate running that must
        // read as deny. Established INSIDE the transaction so the row and the
        // marker become true together — a lease told "acquired" whose offline
        // half does not exist is worse than a refused one.
        establishFence: (lease) => {
          if (!existingAuthority) {
            store.insertValidationLeaseAuthority({
              scope_key: authority.scopeKey,
              lease_id: lease.leaseId,
              run_id: authority.runId,
              outcome_id: authority.outcomeId,
              task_id: authority.taskId,
              dispatch_id: authority.dispatchId,
              worktree_id: authority.worktreeId,
              owner_handle: caller.terminalHandle,
              owner_pane_key: caller.paneKey,
              process_incarnation: caller.processIncarnation,
              launch_token_hash: caller.launchTokenHash,
              runtime_id: runtimeId,
              build_id: buildId,
              expires_at: lease.expiresAt
            })
          }
          writeSentinelFor(
            authority.worktreeId,
            lease.leaseId,
            lease.acquiredAt,
            Date.parse(lease.expiresAt)
          )
        }
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
