import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import {
  fingerprintGateDependencies,
  parseGateDependencySpec
} from '../../orchestration/control-plane/gate-dependency-fingerprint'
import {
  planGateSet,
  type GateInputs
} from '../../orchestration/control-plane/gate-receipt-validity'
import { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'
import { VALIDATION_LEASE_METHOD } from './validation-lease-method'
import { requireRunId } from './validation-lease-sentinel'
import { PhaseLaunchStore } from '../../orchestration/control-plane/phase-launch-store'
import { driveRunPhaseLaunches } from './orchestration-phase-launch'
import {
  DEFAULT_GATE_TIMEOUT_MS,
  GATE_LEASE_MARGIN_MS,
  GateRunParams,
  runGateForDispatch
} from './orchestration-gate-run'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { randomUUID } from 'node:crypto'
import { requireLeaseOwnerAuthority } from '../../orchestration/control-plane/lease-owner-authority'
import {
  acquireValidationLease,
  releaseValidationLease
} from '../../orchestration/control-plane/validation-lease'
import { clearSentinelFor, writeSentinelFor } from './validation-lease-sentinel'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Gates whose receipt proves something about the commit itself, so it must
 *  never be reused across a SHA no matter what their inputs look like. */
const EXACT_HEAD_GATE = /(publish|publication|release|review)/i

const OutcomeAdmitParams = z.object({
  from: OptionalString,
  run: OptionalString,
  outcomeId: requiredString('Missing --outcome-id'),
  title: requiredString('Missing --title'),
  taskClassification: OptionalString,
  builderCandidates: OptionalString,
  reviewerCandidates: OptionalString,
  reviewCapabilities: OptionalString,
  allowUnknownQuota: OptionalBoolean,
  gatePolicy: z.enum(['standard', 'high_risk']).optional()
})

const GatePlanParams = z.object({
  from: OptionalString,
  run: OptionalString,
  outcome: OptionalString,
  sha: requiredString('Missing --sha'),
  gates: requiredString('Missing --gates'),
  files: OptionalString,
  policyVersion: OptionalString,
  record: OptionalString,
  result: z.enum(['PASS', 'FAIL']).optional(),
  riskPolicy: z.enum(['standard', 'high_risk']).optional(),
  /** Root that relative dependency paths resolve against; the caller's worktree. */
  cwd: OptionalString
})

const PhaseLaunchParams = z.object({
  from: OptionalString,
  run: OptionalString,
  drive: OptionalBoolean
})

/** B2/B8/B9 (correction 2) — the typed operations that put outcome policy, gate
 *  receipts and validation leases on real call sites. */
export const ORCHESTRATION_GATE_OPS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.phaseLaunch',
    params: PhaseLaunchParams,
    handler: async (params, ctx) => {
      const { runtime } = ctx
      const runId = params.run ?? requireRunId(runtime, params.from)
      // Why an explicit drive flag: reading the launch ledger must stay a safe
      // recovery query, and forcing a pass must be a deliberate act.
      if (params.drive !== false) {
        await driveRunPhaseLaunches({ runtime, ctx, runId })
      }
      return { runId, launches: new PhaseLaunchStore(runtime.getOrchestrationDb()).list(runId) }
    }
  }),

  defineMethod({
    name: 'orchestration.outcomeAdmit',
    params: OutcomeAdmitParams,
    handler: () => {
      // Historical outcome rows remain readable, but a single-outcome write
      // bypasses the atomic 2-5 manifest, target, relation and required-gate
      // contract.  Keep the method registered only to return a typed migration
      // error to older clients; it must never create a new row.
      throw new OrchestrationError(
        'command_retired',
        'orchestration.outcomeAdmit is read-compatibility only; use orchestration.outcomeIntake with 2-5 complete manifests.'
      )
    }
  }),

  defineMethod({
    name: 'orchestration.gateRun',
    params: GateRunParams,
    handler: async (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const caller = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence
      )
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      if (
        !caller ||
        caller.terminalHandle !== params.from ||
        !dispatch ||
        dispatch.assignee_handle !== caller.terminalHandle ||
        dispatch.assignee_pane_key !== caller.paneKey ||
        dispatch.process_incarnation !== caller.processIncarnation ||
        dispatch.launch_token_hash !== caller.launchTokenHash
      ) {
        throw new OrchestrationError(
          'sender_not_assignee',
          `Required gate ${params.gate} must be requested by the exact live process assigned to Dispatch ${params.dispatch}.`
        )
      }
      const runId = params.run ?? requireRunId(runtime, params.from)
      const authority = requireLeaseOwnerAuthority(db, {
        dispatchId: params.dispatch,
        runId,
        taskId: dispatch.task_id
      })
      const store = new ControlPlaneStore(db)
      const runtimeId = runtime.getStatus().runtimeId
      const buildIdentity = runtime.getBuildIdentity()
      const leaseId = `lease_gate_${randomUUID()}`
      const acquisition = acquireValidationLease(store, {
        scopeKey: authority.scopeKey,
        leaseId,
        owner: params.dispatch,
        idempotencyKey: leaseId,
        nowMs: Date.now(),
        // The fence must outlive the longest permitted child plus the process
        // tree and receipt cleanup window. It is never allowed to expire while
        // the gate process is still reading the worktree.
        ttlMs: (params.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS) + GATE_LEASE_MARGIN_MS,
        establishFence: (lease) => {
          store.insertValidationLeaseAuthority({
            scope_key: authority.scopeKey,
            lease_id: lease.leaseId,
            run_id: authority.runId,
            outcome_id: authority.outcomeId,
            task_id: authority.taskId,
            dispatch_id: authority.dispatchId,
            worktree_id: authority.worktreeId,
            owner_handle: authority.ownerHandle,
            owner_pane_key: authority.ownerPaneKey,
            process_incarnation: authority.processIncarnation,
            launch_token_hash: authority.launchTokenHash,
            runtime_id: runtimeId,
            build_id: buildIdentity.id,
            expires_at: lease.expiresAt
          })
          writeSentinelFor(
            authority.worktreeId,
            lease.leaseId,
            lease.acquiredAt,
            Date.parse(lease.expiresAt)
          )
        }
      })
      if (!acquisition.ok) {
        throw new OrchestrationError(acquisition.code, acquisition.reason)
      }
      let releaseFence = true
      let gateError: unknown
      let gateResult: Awaited<ReturnType<typeof runGateForDispatch>> | undefined
      try {
        gateResult = await runGateForDispatch({
          db,
          runId,
          dispatchId: params.dispatch,
          gateId: params.gate,
          program: params.program,
          args: params.args,
          buildIdentity,
          validationLease: { scopeKey: authority.scopeKey, leaseId, runtimeId },
          ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
        })
      } catch (error) {
        if (
          error instanceof OrchestrationError &&
          typeof error.data === 'object' &&
          error.data !== null &&
          (error.data as { retainValidationFence?: unknown }).retainValidationFence === true
        ) {
          // The exact process tree may still exist. Keep both the DB lease and
          // the offline sentinel until their bounded expiry rather than
          // declaring the tree mutable while a gate descendant is alive.
          releaseFence = false
        }
        gateError = error
      }
      // Why not a `finally`: a throw from there REPLACES the gate's own error,
      // so a release failure would hide the reason the gate failed. The gate's
      // error is the primary one; an unreleasable lease then simply stays held
      // until its bounded expiry, which is the safe direction.
      if (releaseFence) {
        const released = releaseValidationLease(store, {
          scopeKey: authority.scopeKey,
          leaseId,
          nowMs: Date.now(),
          owner: params.dispatch
        })
        if (!released.released) {
          if (gateError) {
            throw gateError
          }
          throw new OrchestrationError(
            'validation_lease_release_failed',
            `Required gate ${params.gate} could not prove release of validation lease ${leaseId}.`
          )
        }
        clearSentinelFor(authority.worktreeId, {
          leaseId,
          acquiredAt: acquisition.lease.acquiredAt
        })
      }
      if (gateError) {
        throw gateError
      }
      return gateResult
    }
  }),
  defineMethod({
    name: 'orchestration.gatePlan',
    params: GatePlanParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const runId = params.run ?? requireRunId(runtime, params.from)
      const store = new ControlPlaneStore(db)
      const outcomeId =
        params.outcome ??
        (resolveOutcomeBinding(store, runId).kind === 'admitted'
          ? store.getOutcomeByRun(runId)?.outcome_id
          : undefined)
      const scopeKey = `${runId}:${outcomeId ?? 'unbound'}`
      const policyVersion = params.policyVersion ?? 'unversioned'
      const fallbackFiles = splitCsv(params.files)
      const cwd = params.cwd ?? process.cwd()
      const gates: GateInputs[] = splitCsv(params.gates).map((token) => {
        const spec = parseGateDependencySpec(token)
        const commandIdentity = spec.gateId
        return {
          gateId: spec.gateId,
          finalSha: params.sha,
          // Why per gate: one shared input set makes every gate rerun whenever
          // any file changes, which is the opposite of an incremental gate.
          inputHashes: fingerprintGateDependencies({
            spec,
            fallbackFiles,
            cwd,
            policyVersion,
            commandIdentity
          }),
          policyVersion,
          commandIdentity,
          shaBinding: EXACT_HEAD_GATE.test(spec.gateId) ? 'exact_head' : 'content'
        }
      })
      if (gates.length === 0) {
        throw new OrchestrationError('invalid_argument', '--gates must name at least one gate.')
      }
      if (params.record) {
        throw new OrchestrationError(
          'command_retired',
          'Callers cannot record gate results. Use orchestration.gateRun so the runtime observes the canonical command and exit status.'
        )
      }
      const riskPolicy =
        params.riskPolicy ?? store.getOutcomeByRun(runId)?.gate_policy ?? 'standard'
      const plan = planGateSet({ store, scopeKey, gates, riskPolicy })
      return { scopeKey, riskPolicy, ...plan }
    }
  }),

  VALIDATION_LEASE_METHOD
]
