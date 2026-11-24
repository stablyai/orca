// An ask a paired server's agent sent an agent here is admitted through the peer-mail bot path, for
// no one here, once allowed or approved; the waiting row goes in the admission's write.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { OrchestrationError } from '../../orchestration-error'
import { ClientAskPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { deliverPeerMailToBot } from '../../../rpc/methods/orchestration/federation/peer-mail-bot-delivery'
import { peerMailSenderSnapshot } from '../peer-mail/peer-mail-sender-snapshot'
import { peerMailPairing } from '../peer-mail/peer-mail-delivery'
import { isGeneratedId } from '../../db/generated-id'
import {
  dropPairedServerAsk,
  getPairedServerAsk,
  isReplacedServerPairing,
  listPairedServerAsks,
  type PairedServerAskRow
} from '../../db/federation/paired-server-asks-store'
import { declineHeldPairedServerAsk, safeJson } from './paired-server-ask-import'
import { toSafeDisplayLine } from '../../../../../shared/text/display-text-safety'

// Admissions running now, by message id, so two answers or two passes never admit one ask twice.
const admitting = new Set<string>()

/** The pairing a held ask came under, kept here: admitting needs no connection, and the answer goes
 *  back when the server is reached again. None for a row an older build kept under any id but a
 *  reverse conversation's: its replies would join that id's queue (a Dispatch's). */
export function heldAskPairing(db: OrchestrationDb, row: PairedServerAskRow): string | undefined {
  const conversation = isGeneratedId(row.conversation_id, 'peerconv')
    ? db.getPeerMailConversation(row.conversation_id)
    : undefined
  return conversation?.role === 'peer' ? conversation.peer_fingerprint : undefined
}

/** At commit, after every wait: the same ask still waits here, as it was read (same bot, server and
 *  conversation), and `botId`, the bot it is about to reach, is the one it was approved for. A
 *  decline, removal or replacement since, or a name lookup landing on another bot, admits nothing. */
export function stillAdmits(db: OrchestrationDb, row: PairedServerAskRow, botId: string): boolean {
  const current = getPairedServerAsk(db, row.message_id)
  const pairing = heldAskPairing(db, row)
  return (
    botId === row.bot_id &&
    current?.state === 'admit' &&
    current.bot_id === row.bot_id &&
    current.server_key === row.server_key &&
    current.conversation_id === row.conversation_id &&
    // Still the pairing this computer announced: a re-pair since settled the ask (its answer
    // could never go back), even when its announcement could not drop the row before this write.
    pairing !== undefined &&
    !isReplacedServerPairing(db, row.environment_id, pairing)
  )
}

async function admit(runtime: OrcaRuntimeService, row: PairedServerAskRow): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const parsed = ClientAskPayload.safeParse(safeJson(row.payload))
  // A row it can't name a pairing for is declined unread, and no notice goes under its id.
  const pairing = heldAskPairing(db, row)
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
  const server = await runtime
    .resolveOrchestrationWorkerServer(row.environment_id)
    .catch(() => undefined)
  // Re-paired here and not announced yet: it waits, and that announcement settles it, since its
  // answer could not go back. A server not in the catalog now is admitted as before (offline).
  if (server && peerMailPairing(server) !== pairing) {
    return
  }
  const serverName = server ? toSafeDisplayLine(server.name) : ''
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
        admits: (botId) => stillAdmits(db, row, botId),
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
