import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { describeOutcomeState } from '../../orchestration/control-plane/outcome-state-recovery'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import { readObservedLaunchIdentity } from '../../orchestration/control-plane/certification-event-source'
import { readDispatchLaunchReceipt } from '../../orchestration/control-plane/dispatch-route-identity'
import { resolveWorkerStartRole } from './orchestration-worker-route-admission'
import { OutcomePolicyStore } from '../../orchestration/control-plane/outcome-policy'
import { observeCompletion } from '../../orchestration/control-plane/runtime-observed-completion'
import { requiredGateDefinition } from '../../orchestration/control-plane/required-gate-spec'
import {
  fingerprintGateDependencies,
  hasUnprovableDependency
} from '../../orchestration/control-plane/gate-dependency-fingerprint'
import { hasRuntimeProvenGate } from '../../orchestration/control-plane/runtime-gate-execution'
import { isCertifiableRuntimeBuildIdentity } from '../../orchestration/control-plane/runtime-build-identity'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString } from '../schemas'
import type { OrchestrationDb } from '../../orchestration/db'
import type { MessageRow, TaskRow } from '../../orchestration/types'

const ControlPlaneStateParams = z.object({
  outcome: OptionalString,
  run: OptionalString,
  task: OptionalString,
  dispatch: OptionalString
})

function rejectSelectorMismatch(reason: string): never {
  throw new OrchestrationError('selector_mismatch', reason)
}

function latestTaskForRun(db: OrchestrationDb, runId: string): TaskRow | undefined {
  return db.db
    .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(runId) as TaskRow | undefined
}

function messageMatchesSelection(
  message: MessageRow,
  args: { outcomeId?: string; taskId?: string; dispatchId?: string; assigneeHandle?: string | null }
): boolean {
  let payload: Record<string, unknown> = {}
  try {
    const parsed = message.payload ? JSON.parse(message.payload) : null
    payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    payload = {}
  }
  for (const [key, expected] of [
    ['outcomeId', args.outcomeId],
    ['taskId', args.taskId],
    ['dispatchId', args.dispatchId]
  ] as const) {
    if (expected && typeof payload[key] === 'string' && payload[key] !== expected) {
      return false
    }
  }
  if (!args.dispatchId) {
    return true
  }
  return payload.dispatchId === args.dispatchId || message.from_handle === args.assigneeHandle
}

function completionGateState(args: {
  store: ControlPlaneStore
  db: OrchestrationDb
  outcomeId: string | undefined
  runId: string | undefined
  taskId: string | undefined
  dispatchId: string | undefined
  buildId: string
  buildCertifiable: boolean
}): { required: boolean; satisfied: boolean; blockingGate: string | null } {
  if (!args.outcomeId) {
    return { required: false, satisfied: false, blockingGate: null }
  }
  if (!args.runId || !args.taskId || !args.dispatchId) {
    return { required: true, satisfied: false, blockingGate: 'dispatch' }
  }
  if (!args.buildCertifiable) {
    return { required: true, satisfied: false, blockingGate: 'build_provenance' }
  }
  const worker = args.db.getWorkerDispatch(args.dispatchId)
  if (!worker?.worktree_id) {
    return { required: true, satisfied: false, blockingGate: 'worktree' }
  }
  const observed = observeCompletion({ db: args.db, dispatchId: args.dispatchId })
  if (!observed.observable || !observed.worktreePath) {
    return { required: true, satisfied: false, blockingGate: 'runtime_observation' }
  }
  if (observed.clean !== true || !observed.headSha) {
    return { required: true, satisfied: false, blockingGate: 'head_sha' }
  }
  const outcome = args.store.getOutcomeById(args.outcomeId)
  const phase = new OutcomePolicyStore(args.db).findPhaseByTask(args.taskId)
  if (phase?.kind === 'review') {
    return {
      required: true,
      satisfied: observed.headSha === phase.bound_sha,
      blockingGate: observed.headSha === phase.bound_sha ? null : 'review_sha'
    }
  }
  const required = args.store.listRequiredGateSpecs(args.outcomeId)
  if (required.length === 0) {
    return { required: true, satisfied: false, blockingGate: 'required_gate_manifest' }
  }
  for (const row of required) {
    const gate = requiredGateDefinition(row)
    const inputHashes = fingerprintGateDependencies({
      spec: { gateId: gate.gateId, files: gate.dependencies },
      fallbackFiles: [],
      cwd: observed.worktreePath,
      policyVersion: gate.policyVersion,
      commandIdentity: gate.commandIdentity,
      program: gate.program
    })
    if (
      hasUnprovableDependency(inputHashes) !== null ||
      !hasRuntimeProvenGate(args.store, {
        scopeKey: `${args.runId}:${args.outcomeId}`,
        gateId: gate.gateId,
        finalSha: observed.headSha,
        buildId: args.buildId,
        runId: args.runId,
        outcomeId: args.outcomeId,
        dispatchId: args.dispatchId,
        worktreeId: worker.worktree_id,
        specHash: row.spec_hash,
        inputHashes,
        shaBinding: gate.shaBinding,
        riskPolicy: outcome?.gate_policy ?? 'standard'
      })
    ) {
      return { required: true, satisfied: false, blockingGate: gate.gateId }
    }
  }
  return { required: true, satisfied: true, blockingGate: null }
}

/** B10 — the single bounded recovery query. Read-only: it never mutates
 *  lifecycle state, so a recovering caller can always run it safely. */
export const ORCHESTRATION_CONTROL_PLANE_STATE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.state',
    params: ControlPlaneStateParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (!params.outcome && !params.run && !params.task && !params.dispatch) {
        throw new OrchestrationError(
          'invalid_argument',
          'Select at least one target: outcome, run, task, or dispatch.'
        )
      }
      const store = new ControlPlaneStore(db)
      const registryStore = new RouteRegistryStore(db)
      if (params.run && !db.getRun(params.run)) {
        throw new OrchestrationError('target_not_found', `Run ${params.run} does not exist.`)
      }
      const dispatch = params.dispatch ? db.getDispatchContextById(params.dispatch) : undefined
      if (params.dispatch && !dispatch) {
        throw new OrchestrationError(
          'target_not_found',
          `Dispatch ${params.dispatch} does not exist.`
        )
      }
      let task = params.task
        ? db.getTask(params.task)
        : dispatch
          ? db.getTask(dispatch.task_id)
          : undefined
      if (params.task && !task) {
        throw new OrchestrationError('target_not_found', `Task ${params.task} does not exist.`)
      }
      const outcome = params.outcome ? store.getOutcomeById(params.outcome) : undefined
      if (params.outcome && !outcome) {
        throw new OrchestrationError(
          'target_not_found',
          `Outcome ${params.outcome} does not exist.`
        )
      }
      if (dispatch && params.task && dispatch.task_id !== params.task) {
        rejectSelectorMismatch(
          `Dispatch ${dispatch.id} belongs to Task ${dispatch.task_id}, not ${params.task}.`
        )
      }
      if (task && params.run && task.run_id !== params.run) {
        rejectSelectorMismatch(`Task ${task.id} belongs to Run ${task.run_id}, not ${params.run}.`)
      }
      if (dispatch && params.run && dispatch.run_id !== params.run) {
        rejectSelectorMismatch(
          `Dispatch ${dispatch.id} belongs to Run ${dispatch.run_id}, not ${params.run}.`
        )
      }
      if (outcome && params.run && outcome.run_id !== params.run) {
        rejectSelectorMismatch(
          `Outcome ${outcome.outcome_id} belongs to Run ${outcome.run_id}, not ${params.run}.`
        )
      }
      const selectedRunId = params.run ?? task?.run_id ?? dispatch?.run_id ?? outcome?.run_id
      const boundOutcome = selectedRunId ? store.getOutcomeByRun(selectedRunId) : undefined
      if (outcome && boundOutcome && boundOutcome.outcome_id !== outcome.outcome_id) {
        rejectSelectorMismatch(
          `Run ${selectedRunId} is bound to outcome ${boundOutcome.outcome_id}, not ${outcome.outcome_id}.`
        )
      }
      if (outcome && selectedRunId && outcome.run_id !== selectedRunId) {
        rejectSelectorMismatch(
          `Outcome ${outcome.outcome_id} belongs to Run ${outcome.run_id}, not ${selectedRunId}.`
        )
      }
      task ??= selectedRunId ? latestTaskForRun(db, selectedRunId) : undefined
      const selectedDispatch = dispatch ?? (task ? db.getDispatchContext(task.id) : undefined)
      // Why the outcome's own Run: an outcome-only query must still resolve the
      // mailbox, otherwise recovery reports "no events" for a busy Run.
      const runId = selectedRunId
      const resolvedOutcome = outcome ?? boundOutcome
      const role = task ? resolveWorkerStartRole(db, task.id) : null
      const launch = selectedDispatch ? readDispatchLaunchReceipt(db, selectedDispatch.id) : null
      const routeIdentity = selectedDispatch
        ? readObservedLaunchIdentity(db, selectedDispatch.id)
        : null
      const build = runtime.getBuildIdentity()
      // Why bounded: the newest page of the Run mailbox, not the whole history.
      // The report only needs the newest wake-worthy row.
      const recentMessages = runId
        ? db.getRunMailboxHistory(runId, 25).filter((message) =>
            messageMatchesSelection(message, {
              outcomeId: resolvedOutcome?.outcome_id,
              taskId: task?.id,
              dispatchId: selectedDispatch?.id,
              assigneeHandle: selectedDispatch?.assignee_handle
            })
          )
        : []
      return describeOutcomeState(
        {
          outcomeId: resolvedOutcome?.outcome_id ?? params.outcome,
          runId,
          taskId: task?.id ?? params.task,
          dispatchId: selectedDispatch?.id ?? params.dispatch
        },
        {
          store,
          outcome: resolvedOutcome,
          task: task ?? undefined,
          dispatch: selectedDispatch ?? undefined,
          // Why reversed: getRunMailboxHistory returns newest-first, and the
          // picker scans from the end.
          recentMessages: recentMessages.toReversed(),
          routeEvidence: registryStore.listRouteEvidence(),
          routeIdentity,
          requestedRouteIdentity: launch?.requested ?? null,
          routeRole: role?.role,
          routeSessionMode: role?.sessionMode,
          completionGate: completionGateState({
            store,
            db,
            outcomeId: resolvedOutcome?.outcome_id,
            runId,
            taskId: task?.id,
            dispatchId: selectedDispatch?.id,
            buildId: build.id,
            buildCertifiable: isCertifiableRuntimeBuildIdentity(build)
          }),
          nowMs: Date.now()
        }
      )
    }
  })
]
