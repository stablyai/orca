import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../../../core'
import { OptionalBoolean, OptionalString, requiredString } from '../../../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../../../shared/orchestration-run-pagination'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  assertCallerHandleMatchesEvidence,
  resolveNativeCoordinatorSession,
  resolveOrchestrationCaller
} from './run-scope'
import { exposeRun } from './run-receipt'

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: OptionalString,
  agentSessionId: OptionalString,
  runtimeFence: z.number().int().positive().optional()
})

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: OptionalString,
  agentSessionId: OptionalString,
  runtimeFence: z.number().int().positive().optional(),
  takeoverLegacy: OptionalBoolean
})

const RunCurrentParams = z.object({
  from: OptionalString,
  agentSessionId: OptionalString,
  runtimeFence: z.number().int().positive().optional()
})
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
      if (params.agentSessionId) {
        if (params.runtimeFence === undefined) {
          throw new OrchestrationError('consumer_fenced', 'Missing native session lease fence.')
        }
        resolveNativeCoordinatorSession(runtime, params.agentSessionId, params.runtimeFence)
        const db = runtime.getOrchestrationDb()
        const run = db.createRun({
          objective: params.objective,
          coordinatorAgentSessionId: params.agentSessionId
        })
        return { run: exposeRun(run) }
      }
      const coordinatorHandle = params.from
      if (!coordinatorHandle) {
        throw new OrchestrationError('stable_pane_required', 'Missing coordinator identity.')
      }
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: coordinatorHandle,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle,
        coordinatorPaneKey: paneKey
      })
      runtime.cancelMessageWaiters(coordinatorHandle)
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
      if (params.agentSessionId) {
        if (params.runtimeFence === undefined) {
          throw new OrchestrationError('consumer_fenced', 'Missing native session lease fence.')
        }
        resolveNativeCoordinatorSession(runtime, params.agentSessionId, params.runtimeFence)
        const run = runtime.getOrchestrationDb().bindRun({
          runId: params.id,
          coordinatorAgentSessionId: params.agentSessionId
        })
        if (!run) {
          throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
        }
        return { run: exposeRun(run) }
      }
      if (!params.from) {
        throw new OrchestrationError('stable_pane_required', 'Missing coordinator identity.')
      }
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerAgentSessionId: params.agentSessionId,
        callerRuntimeFence: params.runtimeFence,
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
      return { run: exposeRun(run) }
    }
  }),
  defineMethod({
    name: 'orchestration.runCurrent',
    params: RunCurrentParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      if (params.agentSessionId) {
        if (params.runtimeFence === undefined) {
          throw new OrchestrationError('consumer_fenced', 'Missing native session lease fence.')
        }
        resolveNativeCoordinatorSession(runtime, params.agentSessionId, params.runtimeFence)
        const run = runtime.getOrchestrationDb().getCurrentRunForAgentSession(params.agentSessionId)
        return { run: run ? exposeRun(run) : null }
      }
      if (!params.from) {
        throw new OrchestrationError('stable_pane_required', 'Missing coordinator identity.')
      }
      const paneKey = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerAgentSessionId: params.agentSessionId,
        callerRuntimeFence: params.runtimeFence,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireStablePane: true
      })
      const run = runtime.getOrchestrationDb().getCurrentRunForPane(paneKey)
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
