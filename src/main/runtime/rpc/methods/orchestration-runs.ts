import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'

const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal')
})

const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal')
})

const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })
const RunListParams = z.object({})
const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })

function requireCallerPane(runtime: OrcaRuntimeService, handle: string): string {
  const paneKey = runtime.getTerminalPaneKey(handle)
  if (!paneKey) {
    throw new OrchestrationError(
      'stable_pane_required',
      'The coordinator terminal has no stable pane identity. Run this command inside a live Orca terminal.'
    )
  }
  return paneKey
}

export const ORCHESTRATION_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.runCreate',
    params: RunCreateParams,
    handler: (params, { runtime }) => {
      const paneKey = requireCallerPane(runtime, params.from)
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.createRun({
        objective: params.objective,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey
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
    handler: (params, { runtime }) => {
      const paneKey = requireCallerPane(runtime, params.from)
      const db = runtime.getOrchestrationDb()
      const priorRun = db.getCurrentRunForPane(paneKey)
      const run = db.bindRun({
        runId: params.id,
        coordinatorHandle: params.from,
        coordinatorPaneKey: paneKey
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
    handler: (params, { runtime }) => {
      const paneKey = requireCallerPane(runtime, params.from)
      return { run: runtime.getOrchestrationDb().getCurrentRunForPane(paneKey) ?? null }
    }
  }),
  defineMethod({
    name: 'orchestration.runList',
    params: RunListParams,
    handler: (_params, { runtime }) => ({ runs: runtime.getOrchestrationDb().listRuns() })
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
