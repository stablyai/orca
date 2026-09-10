import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../../../core'
import { OptionalBoolean, OptionalString, requiredString } from '../../../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../../../shared/orchestration-run-pagination'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  assertCallerHandleMatchesEvidence,
  resolveOrchestrationCaller,
  resolveRunScope
} from './run-scope'
import { ORCHESTRATION_COORDINATOR_HANDOFF_METHODS } from '../../orchestration-coordinator-handoff'
import { adoptCurrentCoordinatorLease } from '../../../../orchestration/maestro-terminal-lease-reconciliation'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'
import { exposeRun } from './run-receipt'

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal')
})

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })
const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})
const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })
const RunSettleParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal')
})
const RunCompleteParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  summary: z.string().trim().min(1).max(2_048),
  evidence: z.array(z.string().trim().min(1).max(2_048)).min(1).max(64),
  waivers: z
    .array(
      z
        .object({
          task_id: z.string().trim().min(1).max(512),
          reason: z.string().trim().min(1).max(2_048)
        })
        .strict()
    )
    .max(64)
    .default([])
})

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
  ...ORCHESTRATION_COORDINATOR_HANDOFF_METHODS,
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey
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
    handler: async (
      params,
      {
        runtime,
        legacyCoordinatorAuthority,
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority: callerAuthority
      }
    ) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerAuthority,
        requireStablePane: true,
        evidenceAssertedByCaller: true
      })
      if (
        params.takeoverLegacy &&
        (callerAuthority?.terminalHandle !== params.from || callerAuthority.paneKey !== paneKey)
      ) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy takeover must be invoked by the live coordinator agent terminal it will bind. No effects were applied.',
          { effectsApplied: false }
        )
      }
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const persistedRun = db.getRun(params.id)
      const reusesPersistedAuthority = Boolean(
        persistedRun?.coordinator_handle === params.from &&
        persistedRun.coordinator_pane_key &&
        isEquivalentPaneKey(persistedRun.coordinator_pane_key, paneKey)
      )
      const run = db.bindRun({
        runId: params.id,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        takeoverLegacy: params.takeoverLegacy,
        legacyCoordinatorAuthority
      })
      if (!run) {
        throw new OrchestrationError(
          'run_not_found',
          `Run ${params.id} was not found or is inspect-only.`
        )
      }
      if (
        reusesPersistedAuthority &&
        callerAuthority?.terminalHandle === params.from &&
        callerAuthority.paneKey === paneKey
      ) {
        await adoptCurrentCoordinatorLease({
          runtime,
          runId: run.id,
          generation: run.consumer_generation,
          terminalHandle: params.from,
          paneKey,
          spawnedBy: 'authenticated-run-use',
          callerAuthority
        })
      }
      runtime.cancelMessageWaiters(params.from)
      runtime.cancelMessageWaiters(`run:${params.id}`)
      if (priorRun && priorRun.id !== params.id) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run: exposeRun(run, db.getRunCompletion(run.id)) }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
    params: RunCurrentParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const run = runtime.getOrchestrationDb().getCurrentRunForPane(paneKey)
      const db = runtime.getOrchestrationDb()
      return { run: run ? exposeRun(run, db.getRunCompletion(run.id)) : null }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) => {
      const listed = runtime.getOrchestrationDb().listRuns(params)
      return {
        ...listed,
        runs: listed.runs.map((run) =>
          exposeRun(run, runtime.getOrchestrationDb().getRunCompletion(run.id))
        )
      }
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
      return { run: exposeRun(run, runtime.getOrchestrationDb().getRunCompletion(run.id)) }
    }
  }),
  defineMethod({
    name: 'orchestration.runComplete',
    params: RunCompleteParams,
    handler: (params, { legacyCoordinatorRunId, orchestrationCompatibilityEvidence, runtime }) => {
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      if (!run.coordinator_pane_key) {
        throw new OrchestrationError(
          'stable_pane_required',
          'The coordinator Run has no stable pane identity.'
        )
      }
      return runtime.getOrchestrationDb().completeRun({
        runId: run.id,
        summary: params.summary,
        evidence: params.evidence,
        waivers: params.waivers,
        coordinatorHandle: params.from,
        coordinatorPaneKey: run.coordinator_pane_key,
        coordinatorGeneration: run.consumer_generation
      })
    }
  }),
  defineMethod({
    name: 'orchestration.runSettle',
    params: RunSettleParams,
    handler: async (
      params,
      { legacyCoordinatorRunId, orchestrationCompatibilityEvidence, runtime }
    ) => {
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      return await runtime.settleOrchestrationRun(run.id)
    }
  })
]
