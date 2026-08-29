import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../shared/orchestration-run-pagination'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  assertCallerHandleMatchesEvidence,
  resolveOrchestrationCaller
} from './orchestration-run-scope'

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

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
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
      return { run, binding: { consumerGeneration: run.consumer_generation } }
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
      runtime.cancelMessageWaiters(params.from)
      runtime.cancelMessageWaiters(`run:${params.id}`)
      if (priorRun && priorRun.id !== params.id) {
        runtime.cancelMessageWaiters(`run:${priorRun.id}`)
      }
      return { run, binding: { consumerGeneration: run.consumer_generation } }
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
      return { run: runtime.getOrchestrationDb().getCurrentRunForPane(paneKey) ?? null }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) => runtime.getOrchestrationDb().listRuns(params)
  }),
  defineMethod({
    name: 'orchestration.runShow',
    params: RunShowParams,
    handler: (params, { runtime }) => {
      const run = runtime.getOrchestrationDb().getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      return { run }
    }
  })
]
