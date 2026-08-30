import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveRunScope } from './orchestration-run-scope'

const CapacityConfigureParams = z.object({
  target: z.number().int().min(0).max(64),
  run: OptionalString,
  from: requiredString('Missing coordinator terminal')
})

const CapacityTaskParams = z.object({
  task: requiredString('Missing --task'),
  eligible: z.boolean(),
  run: OptionalString,
  from: requiredString('Missing coordinator terminal')
})

const CapacityShowParams = z.object({
  run: OptionalString,
  from: OptionalString
})

export const ORCHESTRATION_CAPACITY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.capacityConfigure',
    params: CapacityConfigureParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      return { capacity: runtime.getOrchestrationDb().configureRunCapacity(run.id, params.target) }
    }
  }),
  defineMethod({
    name: 'orchestration.capacityTaskSet',
    params: CapacityTaskParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const existing = db.getTask(params.task)
      if (!existing || existing.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }
      return { task: db.setTaskCapacityEligibility(params.task, params.eligible) }
    }
  }),
  defineMethod({
    name: 'orchestration.capacityShow',
    params: CapacityShowParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const explicitRun = params.run ? db.getRun(params.run) : undefined
      const run =
        explicitRun?.legacy === 0
          ? explicitRun
          : resolveRunScope(runtime, {
              runId: params.run,
              callerTerminalHandle: params.from,
              requireCurrentConsumer: params.run === undefined,
              legacyCoordinatorRunId,
              callerEvidence: orchestrationCompatibilityEvidence
            })
      return { capacity: db.getRunCapacity(run.id) }
    }
  })
]
