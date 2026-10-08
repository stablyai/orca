/**
 * A chat assignee's task, sent as any agent's message into a chat is: the composer's queued send,
 * held as a card while the chat is busy, recording the Dispatch it is from. The operation id is
 * derived from the Dispatch, so a second send for one Dispatch replays instead of queueing twice.
 */

import { createHash } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../../../shared/agent-session-message-source'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { chatAssigneeSessionId, observeChatAssignee } from '../../../orchestration/chat-assignee'
import type { OrchestrationDb } from '../../../orchestration/db'
import { exposeUtcTimestamp } from '../../../orchestration/db/utc-timestamp'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { sendAgentTurn } from '../../../orchestration/send-agent-turn'
import { structuredPointerCallerKey } from '../../../orchestration/structured-mailbox-pointer-host'
import type { DispatchContextRow } from '../../../orchestration/types'
import { preambleDispatchState } from '../orchestration-structured-worker-session'

/** Handed over in every case: started, still starting its agent, or held as a card. */
export type ChatTaskDelivery = 'accepted' | 'pending' | 'queued'

type ChatTaskDispatch = Pick<DispatchContextRow, 'id' | 'assignee_handle' | 'created_at'>

/** The host's `<13-digit ms>-<32 hex>` shape, stamped at the Dispatch's creation. */
export function chatTaskOperationId(
  dispatch: Pick<DispatchContextRow, 'id' | 'created_at'>
): string {
  const createdAt = Date.parse(exposeUtcTimestamp(dispatch.created_at) ?? dispatch.created_at)
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error(`Dispatch ${dispatch.id} has an unreadable creation time.`)
  }
  const digest = createHash('sha256').update(dispatch.id).digest('hex').slice(0, 32)
  return `${String(createdAt).padStart(13, '0')}-${digest}`
}

/** Sends the task into the chat's live session. Throws when nothing was handed over. */
export async function sendChatTask(args: {
  db: OrchestrationDb
  dispatch: ChatTaskDispatch
  /** Who the task is from (`dispatchTaskSource`), shown on the chat's card or turn. */
  from: AgentMessageSource
  preamble: string
}): Promise<ChatTaskDelivery> {
  const sessionId = chatAssigneeSessionId(args.dispatch.assignee_handle)
  const host = getStructuredAgentSessionHost()
  const observed =
    sessionId && host ? observeChatAssignee(sessionId, args.db, host.deps.store) : null
  if (!host || observed?.status !== 'live') {
    throw new OrchestrationError(
      'dispatch_preamble_undelivered',
      `The task was not delivered: ${observed && observed.status !== 'live' ? observed.reason : 'the chat cannot be reached here.'}`
    )
  }
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: args.preamble }],
    from: args.from
  }
  const outcome = await sendAgentTurn({
    kind: 'structured-session',
    host,
    sessionId: observed.session.sessionId,
    callerKey: structuredPointerCallerKey(args.dispatch.id),
    turn: {
      body,
      // As a person's message is: a busy chat queues it as a card, sent when the queue reaches it.
      delivery: 'queue',
      operationId: chatTaskOperationId(args.dispatch),
      expectedRuntimeFence: observed.session.lease.runtimeFence
    }
  })
  switch (outcome.kind) {
    case 'refused':
      throw new OrchestrationError(
        'dispatch_preamble_undelivered',
        `The task was refused: ${outcome.refusal.message}`
      )
    case 'queued':
      return 'queued'
    case 'sent':
      return preambleDispatchState(outcome.submission)
  }
}
