import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { ResetParams } from '../../../../../../shared/rpc-contract/orchestration-params'

export const ORCHESTRATION_RESET_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.reset',
    access: { kind: 'localOnly', targets: {} },
    permission: 'workspace',
    params: ResetParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Removed mail may still wait as cards in chats; their send records outlive the reset until
      // those cards are deleted, and the reset never waits on that.
      const resetting = <T>(result: T): T => {
        runtime.withdrawStaleChatMail()
        return result
      }
      if (params.all) {
        runtime.stopOrchestrationFederationRelay()
        db.resetAll()
        return resetting({ reset: 'all' })
      }
      if (params.tasks) {
        runtime.stopOrchestrationFederationRelay()
        const removed = db.resetTasks()
        return resetting(removed ? { reset: 'tasks', removed } : { reset: 'tasks' })
      }
      if (params.messages) {
        db.resetMessages()
        return resetting({ reset: 'messages' })
      }
      throw new Error('Invalid reset scope')
    }
  })
]
