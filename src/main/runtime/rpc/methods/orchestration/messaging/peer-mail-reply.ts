import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationEntryCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import type { PeerMailMessageRow } from '../../../../orchestration/db/federation/peer-mail-store'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  deliverPeerMail,
  peerMailMessageId,
  peerMailPairing,
  peerMailSenderLabel,
  requirePeerMailServer
} from '../../../../orchestration/federation/peer-mail/peer-mail-delivery'
import { notifyPeerMailQueued } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'

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
    db.enqueueFederationRelay({
      dispatchId: conversation.conversation_id,
      direction: 'to_home',
      kind: 'peer_mail',
      messageId: id,
      payload: JSON.stringify({
        senderLabel,
        fromAddress: replier,
        subject,
        body: params.body,
        threadId
      })
    })
    db.markAsRead([original.id])
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
    threadId
  })
  db.markAsRead([original.id])
  return recordReceiptBeforeNudge(
    args.recordMutationReceipt,
    { message: { id, subject }, to: original.from_handle, server: server.name },
    () => runtime.ensureOrchestrationFederationRelay(),
    { kind: 'federation' }
  )
}
