// The questions this Orca's agents asked agents on paired computers, kept until an answer or notice
// for each comes back, so an unpair or re-pair tells the askers still waiting that none will come.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'
import { resolveBareOrchestrationRecipient } from '../../../rpc/methods/orchestration/messaging/recipient-routing'
import { peerMailLocalRecipient, peerMailPairing } from './peer-mail-delivery'
import type { OrchestrationWorkerServer } from '../environment-transport'
import type { PeerMailRelayPayload } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import type { z } from 'zod'
export function recordPeerQuestionOut(
  db: OrchestrationDb,
  question: {
    messageId: string
    conversationId: string
    environmentId: string
    peerFingerprint: string
    asker: string
    threadId?: string
  }
): void {
  db.db
    .prepare(
      `INSERT OR IGNORE INTO peer_questions_out (
         message_id, conversation_id, environment_id, peer_fingerprint, asker, thread_id, awaiting
       ) VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      question.messageId,
      question.conversationId,
      question.environmentId,
      question.peerFingerprint,
      question.asker,
      question.threadId ?? null
    )
}

/** Its delivery failed: nothing there will answer it, and the sender saw the failure. */
export function forgetPeerQuestionOut(db: OrchestrationDb, messageId: string): void {
  db.db.prepare('DELETE FROM peer_questions_out WHERE message_id = ?').run(messageId)
}

/** A reply came back on this conversation: the question it answers, or is a notice for, is settled.
 *  An older paired Orca names no request, so its reply settles the questions of its thread. Runs
 *  before the reply is stored: a crash between leaves it unacknowledged, so it is pulled again. */
export function settlePeerQuestionsOut(
  db: OrchestrationDb,
  conversationId: string,
  reply: Pick<z.infer<typeof PeerMailRelayPayload>, 'botAnswer' | 'notice' | 'threadId'>
): void {
  const requestId = reply.botAnswer?.requestId ?? reply.notice?.requestId
  if (requestId) {
    db.db
      .prepare(
        `UPDATE peer_questions_out SET awaiting = NULL
         WHERE conversation_id = ? AND message_id = ? AND awaiting = 1`
      )
      .run(conversationId, requestId)
  } else if (reply.threadId) {
    db.db
      .prepare(
        `UPDATE peer_questions_out SET awaiting = NULL
         WHERE conversation_id = ?1 AND awaiting = 1 AND (message_id = ?2 OR thread_id = ?2)`
      )
      .run(conversationId, reply.threadId)
  }
}

/** Tells each asker still waiting on that computer that no answer will come: it was removed (no
 *  `server`), or re-paired, so questions sent under an older pairing are lost with it. */
export function tellUnpairedPeerQuestions(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  params: { environmentId: string } &
    // `currentPairing` keeps the questions sent under it, as a re-paired server's pairing does;
    // `onlyPairing` ends only that pairing's.
    (
      | { serverName: string; reason: string; currentPairing?: string; onlyPairing?: string }
      | { server: OrchestrationWorkerServer }
    )
): void {
  const { serverName, reason, pairing, only } =
    'server' in params
      ? {
          serverName: params.server.name,
          reason: `The pairing with ${params.server.name} was re-made.`,
          pairing: peerMailPairing(params.server),
          only: null
        }
      : { ...params, pairing: params.currentPairing ?? null, only: params.onlyPairing ?? null }
  const waiting = db.db
    .prepare(
      `SELECT message_id, conversation_id, asker, thread_id FROM peer_questions_out
       WHERE environment_id = ?1 AND awaiting = 1 AND (?2 IS NULL OR peer_fingerprint <> ?2)
         AND (?3 IS NULL OR peer_fingerprint = ?3)`
    )
    .all(params.environmentId, pairing, only)
  let anyTold = false
  for (const row of waiting) {
    const id = String(row.message_id)
    const conversation = db.getPeerMailConversation(String(row.conversation_id))
    const handle = conversation ? peerMailLocalRecipient(runtime, conversation) : String(row.asker)
    const recipient = resolveBareOrchestrationRecipient({ runtime, db, handle })
    const told = runLifecycleWriteTransaction(db.db, 'peer_question_unpaired', () => {
      const settled = db.db
        .prepare(
          `UPDATE peer_questions_out SET awaiting = NULL WHERE message_id = ? AND awaiting = 1`
        )
        .run(id).changes
      if (settled === 0) {
        return null
      }
      return db.insertMessage({
        from: serverName,
        to: recipient.ok ? recipient.to : handle,
        subject: 'Re: Question',
        body: `${reason} Your question ${id} there will not be answered. Decide without it, or ask again.`,
        threadId: typeof row.thread_id === 'string' ? row.thread_id : id,
        runId: recipient.ok ? recipient.runId : undefined
      })
    })
    if (told) {
      anyTold = true
      runtime.notifyMessageArrived(told.to_handle, told.type)
    }
  }
  if (anyTold) {
    // The asking chats' cards settle too, on a host with nothing else to announce it.
    runtime.notifyPeerMailReturned()
  }
}
