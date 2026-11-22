// When a person removes a server pairing, or deletes an agent, what waits for them goes too, and
// each asker is told it was declined while that can still reach the server.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { ClientAskPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import {
  dropPairedServerAsk,
  forgetServerRoute,
  listPairedServerAsks,
  rerouteServer,
  routedServerInstallationIds,
  type PairedServerAskRow
} from '../../db/federation/paired-server-asks-store'
import { declinePairedServerAsk } from './paired-server-ask-import'
import { activePairedServerAsks, leavePairedServer } from './paired-server-asks-loop'
import { flushPairedServerReturns } from './paired-server-ask-returns'

function decline(runtime: OrcaRuntimeService, row: PairedServerAskRow): void {
  const db = runtime.getOrchestrationDb()
  const ask = ClientAskPayload.safeParse(JSON.parse(row.payload))
  if (dropPairedServerAsk(db, row.message_id)) {
    declinePairedServerAsk(runtime, db, {
      conversationId: row.conversation_id,
      messageId: row.message_id,
      to: ask.success ? ask.data.to : `bot:${row.bot_id}`,
      subject: ask.success ? ask.data.subject : 'Message'
    })
  }
}

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
      decline(runtime, row)
    }
  }
  db.db.prepare('DELETE FROM paired_server_introductions WHERE bot_id = ?').run(botId)
  db.db.prepare('DELETE FROM paired_server_allowances WHERE bot_id = ?').run(botId)
}

/** Runs before the pairing's credential is deleted: cards are declined and what is owed goes back
 *  once, then the pairing's rows go, unless another pairing still reaches the same server. A server
 *  that can't be reached now tells its askers when this computer pairs again or is removed there. */
export async function settlePairedServerAsksOnRemoval(
  runtime: OrcaRuntimeService,
  environmentId: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const installations = routedServerInstallationIds(db, environmentId)
  for (const state of ['card', 'admit'] as const) {
    for (const row of listPairedServerAsks(db, { state, environmentId })) {
      decline(runtime, row)
    }
  }
  const asks = activePairedServerAsks(runtime, environmentId)
  if (asks) {
    await flushPairedServerReturns(runtime, asks)
    await leavePairedServer(runtime, asks)
  }
  const elsewhere = activePairedServerAsks(runtime).find(
    (other) =>
      other.environmentId !== environmentId && installations.includes(other.serverInstallationId)
  )
  if (elsewhere) {
    rerouteServer(db, elsewhere.serverInstallationId, elsewhere.environmentId)
  } else {
    forgetServerRoute(db, environmentId)
  }
  // Replies to a server this computer no longer reaches can never go out.
  db.db
    .prepare(
      `UPDATE federation_relay_items SET acked_at = datetime('now')
       WHERE direction = 'to_home' AND acked_at IS NULL AND dispatch_id IN (
         SELECT conversation_id FROM peer_mail_conversations WHERE role = 'peer' AND environment_id = ?)`
    )
    .run(environmentId)
}
