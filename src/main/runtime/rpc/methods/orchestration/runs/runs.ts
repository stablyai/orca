import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { readRunRemovedWork } from '../../../../orchestration/db/reset/removed-orchestration-work-read'
import { assertCallerHandleMatchesEvidence, resolveOrchestrationCaller } from './run-scope'
import { exposeRun } from './run-receipt'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationCallerIdentity } from '../../../../orchestration/orchestration-caller-identity'
import type { RunRow } from '../../../../orchestration/types'
import { currentDispatchAssigneeRun } from '../messaging/recipient-routing'
import {
  RunCreateParams,
  RunCurrentParams,
  RunListParams,
  RunShowParams,
  RunUseParams
} from '../../../../../../shared/rpc-contract/orchestration-runs-params'

function cancelBoundDispatchWaiters(
  runtime: OrcaRuntimeService,
  caller: OrchestrationCallerIdentity,
  runId: string
): void {
  const db = runtime.getOrchestrationDb()
  const dispatch = db.getActiveDispatchForIdentity(caller.address, caller.paneKey ?? undefined)
  if (dispatch && currentDispatchAssigneeRun(runtime, db, dispatch)?.id === runId) {
    runtime.cancelMessageWaiters(`dispatch:${dispatch.id}`)
  }
}

/** Create a Run and bind it to the caller, as `run-create` does; one-step `worker-start` reuses it. */
export function createBoundRun(
  runtime: OrcaRuntimeService,
  caller: OrchestrationCallerIdentity,
  from: string,
  objective: string
): RunRow {
  const run = runtime.getOrchestrationDb().createRun({
    objective,
    coordinatorHandle: caller.terminalHandle,
    coordinatorPaneKey: caller.paneKey,
    coordinatorOrcaSessionId: caller.orcaSessionId
  })
  // The earlier Run keeps this consumer, so only waiters that plain check now redirects end.
  runtime.cancelMessageWaiters(from)
  cancelBoundDispatchWaiters(runtime, caller, run.id)
  return run
}

export const ORCHESTRATION_RUN_METHODS = [
  defineMethod({
    name: 'orchestration.runCreate',
    permission: 'workspace',
    params: RunCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, orchestrationCaller, runtime }) => {
      const caller = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller,
        requireStablePane: true
      })
      return { run: exposeRun(createBoundRun(runtime, caller, params.from, params.objective)) }
    }
  }),
  defineMethod({
    name: 'orchestration.runUse',
    permission: 'workspace',
    params: RunUseParams,
    handler: (
      params,
      {
        runtime,
        legacyCoordinatorAuthority,
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority: callerAuthority,
        orchestrationCaller
      }
    ) => {
      const caller = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerAuthority,
        callerSession: orchestrationCaller,
        requireStablePane: true,
        evidenceAssertedByCaller: true
      })
      const db = runtime.getOrchestrationDb()
      // Why: bindRun fences workers and rejects the flag on ordinary Runs before any effect.
      const takeoverNeedsAuthority =
        params.takeoverLegacy &&
        (db.getRun(params.id)?.legacy !== 0 || db.getLegacyAdoption()?.adopted_run_id === params.id)
      if (
        takeoverNeedsAuthority &&
        (callerAuthority?.terminalHandle !== params.from ||
          callerAuthority.paneKey !== caller.paneKey)
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy takeover must be invoked by the live coordinator agent terminal it will bind. No effects were applied.',
          { effectsApplied: false }
        )
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const priorRuns = db.runsBoundToCoordinator(caller)
      const run = db.bindRun({
        runId: params.id,
        coordinatorHandle: caller.terminalHandle,
        coordinatorPaneKey: caller.paneKey,
        coordinatorOrcaSessionId: caller.orcaSessionId,
        takeoverLegacy: params.takeoverLegacy,
        legacyCoordinatorAuthority
      })
      if (!run) {
        throw new OrchestrationError(
          'run_not_found',
          `Run ${params.id} was not found or is inspect-only.`
        )
      }
      runtime.cancelMessageWaiters(params.from)
      cancelBoundDispatchWaiters(runtime, caller, run.id)
      // run-use keeps only this Run, so every Run it held before has a new or no consumer.
      for (const runId of new Set([params.id, ...priorRuns.map((prior) => prior.id)])) {
        runtime.cancelMessageWaiters(`run:${runId}`)
      }
      return { run: exposeRun(run) }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
    permission: 'workspace',
    params: RunCurrentParams,
    handler: (params, { orchestrationCompatibilityEvidence, orchestrationCaller, runtime }) => {
      const caller = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller,
        requireStablePane: true
      })
      const run = runtime.getOrchestrationDb().getCurrentRunForCoordinator(caller)
      return { run: run ? exposeRun(run) : null }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    permission: 'workspace',
    params: RunListParams,
    handler: (params, { runtime }) => {
      const listed = runtime.getOrchestrationDb().listRuns(params)
      return { ...listed, runs: listed.runs.map(exposeRun) }
    }
  }),
  defineMethod({
    name: 'orchestration.runShow',
    permission: 'workspace',
    params: RunShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      const removedWork = readRunRemovedWork(db.db, run.id, params)
      return removedWork ? { run: exposeRun(run), removedWork } : { run: exposeRun(run) }
    }
  })
]
