import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import {
  fingerprintGateDependencies,
  parseGateDependencySpec
} from '../../orchestration/control-plane/gate-dependency-fingerprint'
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
import { VALIDATION_LEASE_METHOD } from './validation-lease-method'
import { requireRunId } from './validation-lease-sentinel'
import { PhaseLaunchStore } from '../../orchestration/control-plane/phase-launch-store'
import { driveRunPhaseLaunches } from './orchestration-phase-launch'
import { GateRunParams, runGateForDispatch } from './orchestration-gate-run'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'

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
    name: 'orchestration.gateRun',
    params: GateRunParams,
    handler: (params, { runtime }) =>
      runGateForDispatch({
        db: runtime.getOrchestrationDb(),
        runId: params.run ?? requireRunId(runtime, params.from),
        dispatchId: params.dispatch,
        gateId: params.gate,
        program: params.program,
        args: params.args,
        buildId: runtime.getBuildIdentity().id,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
      })
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

  VALIDATION_LEASE_METHOD
]
