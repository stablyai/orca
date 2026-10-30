import { defineMethod } from '../../../core'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { InboxParams } from '../schemas'

export const orchestrationInboxMethod = defineMethod({
  name: 'orchestration.inbox',
  permission: 'workspace',
  params: InboxParams,
  handler: (params, { runtime }) => {
    const db = runtime.getOrchestrationDb()
    // Why: stale/unknown handles return empty rather than error — historical rows survive handle deletion (design doc §3.3).
    const exact = params.id ? db.getMessageById(params.id) : undefined
    const recipient = params.terminal
      ? resolveOrchestrationParty(params.terminal, db).address
      : undefined
    const rows = params.id
      ? exact && (!recipient || exact.to_handle === recipient)
        ? [exact]
        : []
      : params.terminal
        ? db.getAllMessagesForHandle(
            resolveOrchestrationParty(params.terminal, db).address,
            params.limit
          )
        : db.getInbox(params.limit)
    const messages = rows.map(({ ordering_origin: _orderingOrigin, ...row }) => row)
    return { messages, count: messages.length }
  }
})
