import { GroupPostParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { sessionCallerOf } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { peerGroupQuestionRecipient } from '../../../../orchestration/federation/peer-mail/peer-group-question'
import {
  peerMailMessageId,
  peerMailSender,
  peerMailSenderLabel,
  queuePeerMailReply
} from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import { notifyPeerMailQueued } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'

export const ORCHESTRATION_GROUP_POST_METHOD = defineOrchestrationMethod({
  name: 'orchestration.groupPost',
  permission: 'workspace',
  params: GroupPostParams,
  access: { kind: 'writes', caller: 'from', targets: { id: 'message' } },
  handler: (
    params,
    { runtime, orchestrationCaller, orchestrationMutation, recordMutationReceipt }
  ) => {
    const db = runtime.getOrchestrationDb()
    const original = db.getMessageById(params.id)
    const route = db.getPeerMailMessage(params.id)
    const conversation = route && db.getPeerMailConversation(route.conversation_id)
    if (
      !original ||
      !route?.group_question ||
      conversation?.role !== 'peer' ||
      conversation.environment_id !== null
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        'Use the ID of a group question received after Orca was updated on both computers. No post was queued.',
        { effectsApplied: false }
      )
    }
    const { to: from } = peerGroupQuestionRecipient(runtime, original, route)
    if (
      sessionCallerOf(orchestrationCaller)?.address !== from ||
      (params.from && params.from !== from)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        'Only the group question’s receiving Home Chat can post a follow-up.',
        { effectsApplied: false }
      )
    }
    if (db.getBotRequestOutcome(original.id) !== 'answered') {
      throw new OrchestrationError(
        'request_mismatch',
        `Answer ${original.id} with orchestration reply first. No post was queued.`,
        { effectsApplied: false }
      )
    }
    const id = peerMailMessageId(orchestrationMutation)
    queuePeerMailReply(db, conversation.conversation_id, id, {
      senderLabel: peerMailSenderLabel(runtime, from),
      fromAddress: from,
      subject: original.subject,
      body: params.body,
      threadId: original.id,
      sender: peerMailSender(runtime, from),
      groupPost: true
    })
    return recordReceiptBeforeNudge(
      recordMutationReceipt,
      { messageId: id, status: 'queued' as const },
      () => notifyPeerMailQueued(db.db),
      { kind: 'messages', targets: [] }
    )
  }
})
