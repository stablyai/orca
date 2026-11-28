import { isQuietBotResult } from '../../shared/bot-quiet-result'
import { isRemoteBotGroupSession } from '../../shared/bots/bot-remote-group-session'
import { readAgentJournalTurnOutcome } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionTurnReply } from '../../shared/agent-session/requests/structured-agent-session-turn-reply'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { generateId } from '../runtime/orchestration/db/generated-id'
import {
  peerMailSender,
  peerMailSenderLabel,
  queuePeerMailReply
} from '../runtime/orchestration/federation/peer-mail/peer-mail-delivery'
import { notifyPeerMailQueued } from '../runtime/orchestration/federation/peer-mail/peer-mail-waiters'
import { replySubject } from '../../shared/orchestration/mailbox/reply-subject'
import { botAnswerOf } from '../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'
import { botRequestRecord } from '../runtime/rpc/methods/orchestration/messaging/bot-request-record'
import { requireStructuredHost } from './bot-chat-session'
import { botRequestIdsOf } from './bot-request-asker'

/** Read each request's accepted turn; the returned writer runs inside question reconciliation's transaction. */
export async function remoteGroupAnswers(
  runtime: OrcaRuntimeService,
  taker: string,
  messageIds: readonly string[]
): Promise<(messageId: string) => boolean> {
  const sessionId = taker.startsWith('session:') ? taker.slice('session:'.length) : ''
  if (!isRemoteBotGroupSession(sessionId)) {
    return () => false
  }
  const db = runtime.getOrchestrationDb()
  const reads = await (await requireStructuredHost(runtime)).journalReads(sessionId)
  const answers = new Map<string, { text: string; operationId: string }>()
  for (const messageId of messageIds) {
    const request = botRequestRecord(db, messageId)
    const operationId = request?.remoteGroup?.operationId
    if (
      request?.remoteGroup?.sessionId !== sessionId ||
      !operationId ||
      request.purpose !== 'question'
    ) {
      continue
    }
    const { snapshot } = await reads.operationWindow({
      operationIds: [operationId],
      throughAnchoredTurns: true,
      withoutToolOutput: true
    })
    for (const item of snapshot.items) {
      if (item.body.kind !== 'turn' || readAgentJournalTurnOutcome(item.body) !== 'success') {
        continue
      }
      const attribution = await reads.turnAttribution(item.body.turnId, snapshot.cursor.sequence)
      const answered = attribution.messages?.some((message) =>
        botRequestIdsOf(message.body, (id) => id === messageId).includes(messageId)
      )
      if (!answered || attribution.turnItemId !== item.itemId) {
        continue
      }
      const { botProse } = structuredAgentSessionTurnReply(snapshot.items, item.itemId)
      const text = botProse.trim()
      if (text && !isQuietBotResult(text)) {
        answers.set(messageId, { text, operationId })
      }
    }
  }
  return (messageId) => {
    const answer = answers.get(messageId)
    const original = db.getMessageById(messageId)
    const record = botRequestRecord(db, messageId)
    const route = db.getPeerMailMessage(messageId)
    const conversation = route && db.getPeerMailConversation(route.conversation_id)
    if (
      !answer ||
      !original ||
      conversation?.role !== 'peer' ||
      original.to_handle !== `orca_session_id:${sessionId}` ||
      record?.remoteGroup?.sessionId !== sessionId ||
      record.remoteGroup.operationId !== answer.operationId
    ) {
      return false
    }
    if (!db.db.isTransaction) {
      throw new Error('A remote group answer must commit with question reconciliation.')
    }
    if (db.getBotRequestOutcome(messageId) === 'answered') {
      return true
    }
    queuePeerMailReply(db, conversation.conversation_id, generateId('msg'), {
      senderLabel: peerMailSenderLabel(runtime, original.to_handle),
      fromAddress: original.to_handle,
      subject: replySubject(original.subject),
      body: answer.text,
      threadId: original.thread_id ?? original.id,
      replyTo: original.id,
      sender: peerMailSender(runtime, original.to_handle),
      ...botAnswerOf(db, original)
    })
    db.markAsRead([messageId], { kind: 'reply' })
    queueMicrotask(() => notifyPeerMailQueued(db.db))
    return true
  }
}
