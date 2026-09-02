import { defineMethod, type RpcMethod } from '../core'
import { ResetParams } from './orchestration-schemas'

export const ORCHESTRATION_RESET_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.reset',
    params: ResetParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (params.all) {
        runtime.stopOrchestrationFederationRelay()
        db.resetAll()
        return { reset: 'all' }
      }
      if (params.tasks) {
        runtime.stopOrchestrationFederationRelay()
        db.resetTasks()
        return { reset: 'tasks' }
      }
      if (params.messages) {
        db.resetMessages()
        return { reset: 'messages' }
      }
      throw new Error('Invalid reset scope')
    }
  })
]
