import { defineMethod, type RpcMethod } from '../core'
import { handleWorkerStart } from './orchestration-worker-start-handler'
import { WorkerStartParams } from './orchestration-worker-start-schema'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (params, ctx) => {
      return handleWorkerStart(params, ctx)
    }
  })
]
