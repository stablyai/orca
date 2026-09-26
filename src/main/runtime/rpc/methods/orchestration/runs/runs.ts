import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { assertCallerHandleMatchesEvidence, resolveOrchestrationCaller } from './run-scope'
import { exposeRun } from './run-receipt'
import { readRunMailboxHome } from '../../../../orchestration/run-mailbox-home'
import {
  RunCreateParams,
  RunCurrentParams,
  RunListParams,
  RunShowParams,
  RunUseParams
} from '../../../../../../shared/rpc-contract/orchestration-runs-params'

export const ORCHESTRATION_RUN_METHODS = [
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, orchestrationCaller, runtime }) => {
      const caller = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller,
        requireStablePane: true
      })
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForCoordinator(caller)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: caller.terminalHandle,
        coordinatorPaneKey: caller.paneKey,
        coordinatorOrcaSessionId: caller.orcaSessionId
      })
      runtime.cancelMessageWaiters(params.from)
      if (priorRun) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run: exposeRun(run) }
    }
  }),
  defineMethod({
    name: 'orchestration.runUse',
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
      if (
        params.takeoverLegacy &&
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
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForCoordinator(caller)
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
      runtime.cancelMessageWaiters(`run:${params.id}`)
      if (priorRun && priorRun.id !== params.id) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run: exposeRun(run) }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
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
    params: RunListParams,
    handler: (params, { runtime }) => {
      const listed = runtime.getOrchestrationDb().listRuns(params)
      return { ...listed, runs: listed.runs.map(exposeRun) }
    }
  }),
  defineMethod({
    name: 'orchestration.runShow',
    params: RunShowParams,
    handler: (params, { runtime }) => {
      const run = runtime.getOrchestrationDb().getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      return {
        run: exposeRun(run),
        routing: readRunMailboxHome(runtime.getOrchestrationDb(), run, runtime.getRuntimeId())
      }
    }
  })
]
