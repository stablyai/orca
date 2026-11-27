// An ask a paired server's agent sent an agent here is admitted as the owner's own mail, through
// the peer-mail bot path, once allowed or approved; the waiting row goes in the admission's write.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'
import { ClientAskPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { deliverPeerMailToBot } from '../../../rpc/methods/orchestration/federation/peer-mail-bot-delivery'
import { peerMailSenderSnapshot } from '../peer-mail/peer-mail-sender-snapshot'
import {
  dropPairedServerAsk,
  listPairedServerAsks,
  type PairedServerAskRow
} from '../../db/federation/paired-server-asks-store'
import { declineHeldPairedServerAsk, safeJson } from './paired-server-ask-import'
import { toSafeDisplayLine } from '../../../../../shared/text/display-text-safety'

// Admissions running now, by message id, so two answers or two passes never admit one ask twice.
const admitting = new Set<string>()

async function admit(runtime: OrcaRuntimeService, row: PairedServerAskRow): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const parsed = ClientAskPayload.safeParse(safeJson(row.payload))
  // The pairing the ask came under, kept here: admitting needs no connection, and the answer goes
  // back when the server is reached again.
  const pairing = db.getPeerMailConversation(row.conversation_id)?.peer_fingerprint
  if (!parsed.success || !pairing) {
    declineHeldPairedServerAsk(runtime, row)
    return
  }
  const { rootSession: _root, ...ask } = parsed.data
  const decline = () => declineHeldPairedServerAsk(runtime, row)
  // Its agent is gone: an address by its id would fall back to a name match on another agent.
  if (!runtime.bots.list().some((bot) => bot.id === row.bot_id)) {
    decline()
    return
  }
  // Named as this computer's own catalog names it, never as the server says.
  const serverName = await runtime
    .resolveOrchestrationWorkerServer(row.environment_id)
    .then((server) => toSafeDisplayLine(server.name))
    .catch(() => '')
  try {
    const routed = await deliverPeerMailToBot(
      runtime,
      // By the bot id its card showed, so a rename while it waited never sends it to another bot.
      {
        ...ask,
        to: `bot:${row.bot_id}`,
        conversationId: row.conversation_id,
        messageId: row.message_id
      },
      pairing,
      peerMailSenderSnapshot(ask.senderLabel, ask.sender),
      {
        environmentId: row.environment_id,
        serverName,
        alsoOnAdmitted: () => void dropPairedServerAsk(db, row.message_id)
      }
    )
    if (routed !== 'delivered') {
      // Only an agent's bot takes these; anything else is declined.
      decline()
    }
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'delivery_in_progress') {
      return
    }
    if (error instanceof OrchestrationError) {
      // Refused here (a paused or removed bot): its asker hears it was declined.
      decline()
      return
    }
    // Anything else leaves it waiting in 'admit' for the next pass.
    console.warn(`[orchestration] Admitting ask ${row.message_id} failed:`, error)
  }
}

/** Admits every ask of this server (or every server) that is allowed or approved; one pass at a
 *  time per ask. */
export async function admitPairedServerAsks(
  runtime: OrcaRuntimeService,
  environmentId?: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  for (const row of listPairedServerAsks(db, { state: 'admit', environmentId })) {
    if (admitting.has(row.message_id)) {
      continue
    }
    admitting.add(row.message_id)
    try {
      await admit(runtime, row)
    } finally {
      admitting.delete(row.message_id)
    }
  }
}
