// When a person removes a server pairing, or deletes an agent, what waits for them goes too, and
// each asker is told it was declined while that can still reach the server.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  forgetServerRoute,
  listPairedServerAsks
} from '../../db/federation/paired-server-asks-store'
import { declineHeldPairedServerAsk } from './paired-server-ask-import'
import { activePairedServerAsks, leavePairedServer } from './paired-server-asks-loop'
import { flushPairedServerReturns } from './paired-server-ask-returns'
import { pairedServerAsksFor } from './paired-server-asks-pull'
import { tellSender } from '../../../rpc/methods/orchestration/messaging/bot-request-sender-notice'

/** A deleted agent's cards and admissions are declined, and nothing names it anymore. A failure is
 *  logged, never thrown: the deletion goes ahead. */
export function forgetPairedServerAsksOf(runtime: OrcaRuntimeService, botId: string): void {
  try {
    forgetAsksOf(runtime, botId)
  } catch (error) {
    console.warn(`[orchestration] Declining asks for deleted bot ${botId} failed:`, error)
  }
}

function forgetAsksOf(runtime: OrcaRuntimeService, botId: string): void {
  const db = runtime.getOrchestrationDb()
  for (const state of ['card', 'admit'] as const) {
    for (const row of listPairedServerAsks(db, { state }).filter((ask) => ask.bot_id === botId)) {
      declineHeldPairedServerAsk(runtime, row)
    }
  }
  db.db.prepare('DELETE FROM paired_server_introductions WHERE bot_id = ?').run(botId)
  db.db.prepare('DELETE FROM paired_server_allowances WHERE bot_id = ?').run(botId)
}

/** Asks an agent here took and hasn't answered: each asker hears the pairing is gone, by the
 *  conversation it asked on; an unread one is taken, so it isn't worked on for nobody. */
function tellUnansweredAskers(runtime: OrcaRuntimeService, environmentId: string): void {
  const db = runtime.getOrchestrationDb()
  const unanswered = db.db
    .prepare(
      `SELECT r.message_id FROM bot_requests r
       JOIN peer_mail_messages p ON p.message_id = r.message_id
       JOIN peer_mail_conversations c ON c.conversation_id = p.conversation_id
       LEFT JOIN bot_request_outcomes o ON o.message_id = r.message_id
       WHERE c.role = 'peer' AND c.environment_id = ? AND o.message_id IS NULL`
    )
    .all(environmentId)
  for (const row of unanswered) {
    const message = db.getMessageById(String(row.message_id))
    if (message) {
      tellSender(runtime, db, message, 'dropped', 'unpaired', undefined, () =>
        db.markAsRead([message.id], { kind: 'dropped', why: 'unpaired' })
      )
    }
  }
}

/** Runs before the pairing's credential is deleted: cards are declined, askers of admitted asks are
 *  told, and what is owed goes back once, then the pairing's rows go. A server that can't be reached
 *  now tells its askers when this computer pairs again or is removed there. */
export async function settlePairedServerAsksOnRemoval(
  runtime: OrcaRuntimeService,
  environmentId: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  for (const state of ['card', 'admit'] as const) {
    for (const row of listPairedServerAsks(db, { state, environmentId })) {
      declineHeldPairedServerAsk(runtime, row)
    }
  }
  tellUnansweredAskers(runtime, environmentId)
  // With no loop running now, what is owed still goes back while the pairing can reach the server.
  const asks =
    activePairedServerAsks(runtime, environmentId) ??
    (await pairedServerAsksFor(runtime, db, environmentId).catch(() => null))
  if (asks) {
    await flushPairedServerReturns(runtime, asks)
    await leavePairedServer(runtime, asks)
  }
  retirePairedServerRoute(runtime, environmentId)
}

/** The removed pairing's rows go, never to another pairing; also when a loop finds the server
 *  removed by a path that ran no settle step. */
export function retirePairedServerRoute(runtime: OrcaRuntimeService, environmentId: string): void {
  const db = runtime.getOrchestrationDb()
  forgetServerRoute(db, environmentId)
  // Replies to a server this computer no longer reaches can never go out.
  db.db
    .prepare(
      `UPDATE federation_relay_items SET acked_at = datetime('now')
       WHERE direction = 'to_home' AND acked_at IS NULL AND dispatch_id IN (
         SELECT conversation_id FROM peer_mail_conversations WHERE role = 'peer' AND environment_id = ?)`
    )
    .run(environmentId)
}
