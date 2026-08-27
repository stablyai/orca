import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import {
  planGateSet,
  recordGateReceipt,
  type GateInputs
} from '../../orchestration/control-plane/gate-receipt-validity'
import {
  admitOutcome,
  outcomeFingerprint,
  resolveOutcomeBinding
} from '../../orchestration/control-plane/outcome-identity'
import { OutcomePolicyStore } from '../../orchestration/control-plane/outcome-policy'
import type { RouteIdentity } from '../../orchestration/control-plane/route-registry-types'
import {
  acquireValidationLease,
  assertMutationAllowed,
  releaseValidationLease
} from '../../orchestration/control-plane/validation-lease'
import { PhaseLaunchStore } from '../../orchestration/control-plane/phase-launch-store'
import { resolveValidationScopeKey } from '../../orchestration/control-plane/validation-scope'
import { driveRunPhaseLaunches } from './orchestration-phase-launch'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseIdentityList(raw: string | undefined): RouteIdentity[] {
  // Format: `agent[:model[:reasoning]]`, comma separated. Deliberately not JSON:
  // PowerShell strips JSON quotes, and the order here is the whole contract.
  return splitCsv(raw).map((entry) => {
    const [agent, model, reasoning] = entry.split(':')
    return {
      agent: agent as RouteIdentity['agent'],
      model: model && model.length > 0 ? model : null,
      reasoning: reasoning && reasoning.length > 0 ? reasoning : null
    }
  })
}

function hashPaths(paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((path) => [path, createHash('sha256').update(path).digest('hex').slice(0, 16)])
  )
}

function requireRunId(
  runtime: Parameters<RpcMethod['handler']>[1]['runtime'],
  from?: string
): string {
  const db = runtime.getOrchestrationDb()
  const paneKey = from ? runtime.getTerminalPaneKey(from) : null
  const run = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
  if (!run) {
    throw new OrchestrationError('run_not_bound', 'This operation requires a bound Run.')
  }
  return run.id
}

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
  riskPolicy: z.enum(['standard', 'high_risk']).optional()
})

const PhaseLaunchParams = z.object({
  from: OptionalString,
  run: OptionalString,
  drive: OptionalBoolean
})

const ValidationLeaseParams = z.object({
  from: OptionalString,
  run: OptionalString,
  action: z.enum(['acquire', 'release', 'check']),
  dispatch: OptionalString,
  leaseId: OptionalString,
  idempotencyKey: OptionalString,
  ttlMs: OptionalFiniteNumber
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
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const runId = params.run ?? requireRunId(runtime, params.from)
      const store = new ControlPlaneStore(db)
      const admission = admitOutcome(store, {
        outcomeId: params.outcomeId,
        runId,
        title: params.title,
        fingerprint: outcomeFingerprint([params.outcomeId, params.title]),
        gatePolicy: params.gatePolicy
      })
      if (!admission.ok) {
        throw new OrchestrationError(admission.error.code, admission.error.reason)
      }
      // Why policy is stored, not inferred: the candidate ORDER comes from the
      // classifying layer. Orca validates and launches that explicit choice.
      new OutcomePolicyStore(db).put({
        outcomeId: params.outcomeId,
        taskClassification: params.taskClassification ?? 'bounded_implementation',
        builderCandidates: parseIdentityList(params.builderCandidates),
        reviewerCandidates: parseIdentityList(params.reviewerCandidates),
        reviewCapabilities: splitCsv(params.reviewCapabilities),
        allowUnknownQuota: params.allowUnknownQuota === true
      })
      return { outcome: admission.outcome, duplicate: admission.duplicate }
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
      const inputHashes = hashPaths(splitCsv(params.files))
      const policyVersion = params.policyVersion ?? 'unversioned'
      const gates: GateInputs[] = splitCsv(params.gates).map((gateId) => ({
        gateId,
        finalSha: params.sha,
        inputHashes,
        policyVersion,
        commandIdentity: gateId
      }))
      if (gates.length === 0) {
        throw new OrchestrationError('invalid_argument', '--gates must name at least one gate.')
      }
      if (params.record) {
        if (!params.result) {
          throw new OrchestrationError(
            'invalid_argument',
            '--record requires --result PASS or FAIL.'
          )
        }
        const recorded = gates.find((gate) => gate.gateId === params.record)
        if (!recorded) {
          throw new OrchestrationError(
            'invalid_argument',
            `--record ${params.record} is not in --gates.`
          )
        }
        recordGateReceipt(store, {
          scopeKey,
          inputs: recorded,
          result: params.result,
          recordedAt: new Date().toISOString()
        })
      }
      const riskPolicy =
        params.riskPolicy ?? store.getOutcomeByRun(runId)?.gate_policy ?? 'standard'
      const plan = planGateSet({ store, scopeKey, gates, riskPolicy })
      return { scopeKey, riskPolicy, ...plan }
    }
  }),

  defineMethod({
    name: 'orchestration.validationLease',
    params: ValidationLeaseParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const runId = params.run ?? requireRunId(runtime, params.from)
      const store = new ControlPlaneStore(db)
      const nowMs = Date.now()
      const scopeKey = await resolveValidationScopeKey({
        runtime,
        terminalHandle: params.from,
        runId
      })
      if (params.action === 'check') {
        return { scopeKey, guard: assertMutationAllowed(store, { scopeKey, nowMs }) }
      }
      if (params.action === 'release') {
        if (!params.leaseId) {
          throw new OrchestrationError('invalid_argument', 'release requires --lease-id.')
        }
        return {
          scopeKey,
          ...releaseValidationLease(store, { scopeKey, leaseId: params.leaseId, nowMs })
        }
      }
      const dispatchId = params.dispatch
      if (!dispatchId) {
        throw new OrchestrationError('invalid_argument', 'acquire requires --dispatch.')
      }
      const idempotencyKey = params.idempotencyKey ?? `${dispatchId}:${params.leaseId ?? 'default'}`
      const acquisition = acquireValidationLease(store, {
        scopeKey,
        leaseId: params.leaseId ?? `lease_${dispatchId}`,
        owner: dispatchId,
        idempotencyKey,
        nowMs,
        ttlMs: params.ttlMs
      })
      if (!acquisition.ok) {
        throw new OrchestrationError(acquisition.code, acquisition.reason, {
          lease: acquisition.lease
        })
      }
      return { scopeKey, ...acquisition }
    }
  })
]
