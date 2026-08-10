import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalBoolean, OptionalString, requiredString } from '../schemas'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../../shared/orchestration-run-pagination'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { assertCallerHandleMatchesEvidence } from './orchestration-run-scope'

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal'),
  parent: OptionalString
})

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })
const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
  parent: OptionalString
})
const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })

function requireCallerPane(
  runtime: OrcaRuntimeService,
  handle: string,
  callerAuthority?: OrchestrationCompatibilityCallerAuthority
): string {
  const paneKey =
    callerAuthority?.terminalHandle === handle
      ? callerAuthority.paneKey
      : runtime.getTerminalPaneKey(handle)
  if (!paneKey) {
    throw new OrchestrationError(
      'stable_pane_required',
      'The coordinator terminal has no stable pane identity. Run this command inside a live Orca terminal.'
    )
  }
  return paneKey
}

// Why: a coordinator dispatched by another coordinator is a child by construction, so its own
// Dispatch names the parent Run without anyone passing an id through a prompt.
function resolveParentRun(
  runtime: OrcaRuntimeService,
  declaredParent: string | undefined,
  callerHandle: string,
  callerPaneKey: string
): string | null {
  const db = runtime.getOrchestrationDb()
  if (declaredParent) {
    const parent = db.getRun(declaredParent)
    if (!parent || parent.legacy === 1) {
      throw new OrchestrationError(
        'run_not_found',
        `Parent Run ${declaredParent} was not found. No effects were applied.`,
        { effectsApplied: false }
      )
    }
    return parent.id
  }
  const dispatchRunId = db.getActiveDispatchForIdentity(callerHandle, callerPaneKey)?.run_id
  const inferred = dispatchRunId ? db.getRun(dispatchRunId) : undefined
  return inferred && inferred.legacy === 0 ? inferred.id : null
}

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime }) => {
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const paneKey = requireCallerPane(runtime, params.from)
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey,
        parentRunId: resolveParentRun(runtime, params.parent, params.from, paneKey)
      })
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
      const paneKey = requireCallerPane(runtime, params.from, callerAuthority)
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
      assertCallerHandleMatchesEvidence(runtime, params.from, orchestrationCompatibilityEvidence)
      const paneKey = requireCallerPane(runtime, params.from)
      return { run: runtime.getOrchestrationDb().getCurrentRunForPane(paneKey) ?? null }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (params, { runtime }) =>
      runtime.getOrchestrationDb().listRuns({
        limit: params.limit,
        cursor: params.cursor,
        parentRunId: params.parent
      })
  }),
  defineMethod({
    name: 'orchestration.runShow',
    params: RunShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getRun(params.id)
      if (!run) {
        throw new OrchestrationError('run_not_found', `Run ${params.id} was not found.`)
      }
      return { run, childRunIds: db.listChildRunIds(run.id) }
    }
  })
]
