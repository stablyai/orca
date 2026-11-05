import { defineMethod } from '../../../core'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { InboxParams } from '../schemas'

export const ORCHESTRATION_INBOX_METHODS = [
  defineMethod({
    name: 'orchestration.inbox',
    permission: 'workspace',
    params: InboxParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Return empty for stale/unknown handles because historical mail outlives handle deletion (design doc §3.3).
      const messages = params.terminal
        ? db.getAllMessagesForHandle(
            resolveOrchestrationParty(params.terminal, db).address,
            params.limit
          )
        : db.getInbox(params.limit)
      return { messages, count: messages.length }
    }
  })
]
