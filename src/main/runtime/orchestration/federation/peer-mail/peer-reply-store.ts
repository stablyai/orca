import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { PeerMailRelayPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { resolveBareOrchestrationRecipient } from '../../../rpc/methods/orchestration/messaging/recipient-routing'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { PeerMailConversationRow } from '../../db/federation/peer-mail-store'
import type { MessageRow } from '../../db/orchestration-records'
import { presentImportedPeerItem } from '../../mailbox/formatting/imported-peer-item-presentation'
import { peerMailLocalRecipient } from './peer-mail-delivery'
import { settlePeerQuestionsOut } from './peer-questions-out'

/** Stores a reply on a conversation this Orca opened, once; a replay finds the stored row. Pulled
 *  from a paired server, or returned by a paired computer whose agents this Orca's agents asked. */
export function storePeerReply(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  conversation: PeerMailConversationRow,
  messageId: string,
  payload: z.infer<typeof PeerMailRelayPayload>
): MessageRow | undefined {
  const handle = peerMailLocalRecipient(runtime, conversation)
  // Peer-mail replies come home to this Orca's own sender handle, never a terminal agent's id.
  const recipient = resolveBareOrchestrationRecipient({ runtime, db, handle })
  const { from, body, ...carried } = presentImportedPeerItem({ kind: 'peer_mail', ...payload })
  settlePeerQuestionsOut(db, conversation.conversation_id, payload)
  const stored = db.insertPeerMailMessage({
    conversationId: conversation.conversation_id,
    remoteParty: payload.fromAddress,
    message: {
      id: messageId,
      from,
      to: recipient.ok ? recipient.to : handle,
      subject: payload.subject,
      body,
      threadId: payload.threadId ?? undefined,
      runId: recipient.ok ? recipient.runId : undefined,
      ...carried
    }
  })
  return stored.duplicate ? undefined : stored.message
}
