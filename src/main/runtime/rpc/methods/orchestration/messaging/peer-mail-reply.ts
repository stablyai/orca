import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { PeerMailMessageRow } from '../../../../orchestration/db/federation/peer-mail-store'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  deliverPeerMail,
  peerMailMessageId,
  peerMailPairing,
  peerMailSender,
  peerMailSenderLabel,
  queuePeerMailReply,
  requirePeerMailServer
} from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import { notifyPeerMailQueued } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'
import { botAnswerOf } from './bot-request-outcome'
import { runLifecycleWriteTransaction } from '../../../../orchestration/db/lifecycle-write-transaction-runner'
import { isClientEnvironment } from '../../../../orchestration/federation/client-asks/client-ask-environment'
import { queueClientItem } from '../../../../orchestration/federation/client-asks/client-ask-queue'
import type { ClientReplyPayload } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import type { z } from 'zod'

const NOTHING_SENT = { effectsApplied: false } as const

/** A reply to mail that came from another Orca goes back over that mail's conversation. */
export async function replyOverPeerMail(args: {
  runtime: OrcaRuntimeService
  original: MessageRow
  route: PeerMailMessageRow
  params: { body: string; from?: string; on?: string }
  orchestrationCaller: OrchestrationEntryCaller | undefined
  orchestrationMutation: { callerFingerprint: string; requestId: string } | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
}): Promise<unknown> {
  const { runtime, original, route, params } = args
  const db = runtime.getOrchestrationDb()
  const conversation = db.getPeerMailConversation(route.conversation_id)
  if (!conversation) {
    throw new OrchestrationError(
      'request_mismatch',
      `The conversation ${original.id} came on is gone from this Orca. No reply was sent.`,
      NOTHING_SENT
    )
  }
  const replier = args.orchestrationCaller?.address ?? params.from ?? original.to_handle
  const id = peerMailMessageId(args.orchestrationMutation)
  const subject = original.subject.startsWith('Re: ') ? original.subject : `Re: ${original.subject}`
  const threadId = original.thread_id ?? original.id
  const senderLabel = peerMailSenderLabel(runtime, replier)

  if (params.on !== undefined) {
    throw new OrchestrationError(
      'request_mismatch',
      `${original.id} came from ${original.from_handle}; its reply goes back there by itself. Drop --on. No reply was sent.`,
      NOTHING_SENT
    )
  }

  if (conversation.role === 'peer') {
    const sender = peerMailSender(runtime, replier)
    // The answer's record and its queued reply commit together.
    runLifecycleWriteTransaction(db.db, 'peer_reply_with_answer', () => {
      queuePeerMailReply(db, conversation.conversation_id, id, {
        senderLabel,
        fromAddress: replier,
        subject,
        body: params.body,
        threadId,
        sender,
        // Refuses a second answer to a bot request, before the original is marked read.
        ...botAnswerOf(db, original)
      })
      db.markAsRead([original.id], { kind: 'reply' })
    })
    return recordReceiptBeforeNudge(
      args.recordMutationReceipt,
      { message: { id, subject }, to: original.from_handle },
      () => notifyPeerMailQueued(db.db),
      { kind: 'messages', targets: [] }
    )
  }

  const environmentId = conversation.environment_id ?? ''
  if (!route.remote_party) {
    throw new OrchestrationError(
      'request_mismatch',
      `${original.id} does not say who sent it. No reply was sent.`,
      NOTHING_SENT
    )
  }
  const remoteParty = route.remote_party
  if (isClientEnvironment(environmentId)) {
    // A paired computer pulls it as it pulls asks, and gives it to its agent with no consent step.
    runLifecycleWriteTransaction(db.db, 'client_reply', () => {
      queueClientItem(db, {
        conversationId: conversation.conversation_id,
        messageId: id,
        kind: 'client_reply',
        payload: {
          senderLabel,
          to: remoteParty,
          subject,
          body: params.body,
          threadId,
          sender: peerMailSender(runtime, replier)
        } satisfies z.infer<typeof ClientReplyPayload>
      })
      db.markAsRead([original.id], { kind: 'reply' })
    })
    return recordReceiptBeforeNudge(
      args.recordMutationReceipt,
      { message: { id, subject }, to: original.from_handle },
      () => notifyPeerMailQueued(db.db),
      { kind: 'messages', targets: [] }
    )
  }
  const server = await requirePeerMailServer(runtime, environmentId)
  // After a re-pair the server no longer knows the old conversation; continue it under the new pairing.
  const current = db.openHomePeerMailConversation({
    environmentId,
    peerFingerprint: peerMailPairing(server),
    localParty: conversation.local_party ?? '',
    localPaneKey: conversation.local_pane_key
  })
  await deliverPeerMail(runtime, server, current, {
    id,
    to: route.remote_party,
    senderLabel,
    subject,
    body: params.body,
    threadId,
    sender: peerMailSender(runtime, replier)
  })
  db.markAsRead([original.id], { kind: 'reply' })
  return recordReceiptBeforeNudge(
    args.recordMutationReceipt,
    { message: { id, subject }, to: original.from_handle, server: server.name },
    () => runtime.ensureOrchestrationPeerMailRelay(server.environmentId),
    { kind: 'federation', environmentId: server.environmentId }
  )
}
