import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../../../core'
import { OptionalBoolean, OptionalString, requiredString } from '../../../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../../../shared/orchestration-run-pagination'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { orchestrationCallerParamFields, resolveCallerPrincipal } from '../caller-principal'
import { exposeRun } from './run-receipt'

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  ...orchestrationCallerParamFields
})

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  takeoverLegacy: OptionalBoolean,
  ...orchestrationCallerParamFields
})

const RunCurrentParams = z.object({ ...orchestrationCallerParamFields })
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
      const caller = resolveCallerPrincipal(runtime, {
        from: params.from,
        agentSessionId: params.agentSessionId,
        runtimeFence: params.runtimeFence,
        evidence: orchestrationCompatibilityEvidence,
        requireBindableCaller: true
      })
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPrincipal(caller.principalId)
      const run = db.createRun({ objective: params.objective, coordinator: caller.binding })
      for (const waiterHandle of caller.waiterHandles) {
        runtime.cancelMessageWaiters(waiterHandle)
      }
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
        orchestrationCompatibilityCallerAuthority: callerAuthority
      }
    ) => {
      const caller = resolveCallerPrincipal(runtime, {
        from: params.from,
        agentSessionId: params.agentSessionId,
        runtimeFence: params.runtimeFence,
        evidence: orchestrationCompatibilityEvidence,
        callerAuthority,
        requireBindableCaller: true,
        deferEvidenceAssertion: true
      })
      if (params.takeoverLegacy && !caller.attested) {
        throw new OrchestrationError(
          'legacy_read_only',
          'Legacy takeover must be invoked by the live coordinator agent terminal it will bind. No effects were applied.',
          { effectsApplied: false }
        )
      }
      caller.attestDeclaredCaller()
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPrincipal(caller.principalId)
      const run = db.bindRun({
        runId: params.id,
        coordinator: caller.binding,
        takeoverLegacy: params.takeoverLegacy,
        legacyCoordinatorAuthority
      })
      if (!run) {
        throw new OrchestrationError(
          'run_not_found',
          `Run ${params.id} was not found or is inspect-only.`
        )
      }
      for (const waiterHandle of caller.waiterHandles) {
        runtime.cancelMessageWaiters(waiterHandle)
      }
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
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      const caller = resolveCallerPrincipal(runtime, {
        from: params.from,
        agentSessionId: params.agentSessionId,
        runtimeFence: params.runtimeFence,
        evidence: orchestrationCompatibilityEvidence,
        requireBindableCaller: true
      })
      const run = runtime.getOrchestrationDb().getCurrentRunForPrincipal(caller.principalId)
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
      return { run: exposeRun(run) }
    }
  })
]
