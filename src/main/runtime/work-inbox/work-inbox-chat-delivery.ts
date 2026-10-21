import { createHash } from 'node:crypto'
import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import type { WorkInboxItem } from '../../../shared/work-inbox'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { sendAgentTurn } from '../orchestration/send-agent-turn'
import type { WorkInboxStore } from './work-inbox-store'

/** A late human reply starts the original chat even after its MCP wait ended. */
export async function deliverWorkInboxChatAnswer(
  store: WorkInboxStore,
  item: WorkInboxItem
): Promise<void> {
  const sessionId = parseOrcaSessionAddress(item.agentId)
  if (!sessionId || item.status !== 'answered' || !item.answer || item.answeredAt === undefined) {
    return
  }
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(sessionId)
  if (!host || !record) {
    throw new Error('work_inbox_chat_unavailable')
  }
  const operationId = `${String(item.answeredAt).padStart(13, '0')}-${createHash('sha256').update(`${item.id}:${item.revision}`).digest('hex').slice(0, 32)}`
  const answer = [item.answer.optionLabel, item.answer.text].filter(Boolean).join('\n')
  const outcome = await sendAgentTurn({
    kind: 'structured-session',
    host,
    sessionId,
    callerKey: `trusted-local:work-inbox:${sessionId}`,
    turn: {
      operationId,
      expectedRuntimeFence: record.lease.runtimeFence,
      delivery: 'queue',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `Answer to Work Inbox question ${item.id}:\n${item.question}\n\n${answer}\n\nAcknowledge receipt with acknowledge_answer for question_id ${item.id}, then continue the original task using this answer. This does not waive any other permission checks.`
          }
        ]
      }
    }
  })
  if (
    outcome.kind === 'refused' ||
    (outcome.kind === 'sent' && outcome.submission?.dispatchState === 'rejected')
  ) {
    throw new Error('work_inbox_chat_delivery_rejected')
  }
  if (outcome.kind === 'sent' && outcome.submission?.dispatchState === 'accepted') {
    store.acknowledge(item.id, Date.now())
  }
}
