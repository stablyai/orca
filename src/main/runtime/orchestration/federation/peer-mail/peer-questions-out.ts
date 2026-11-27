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

/** A reply came back on this conversation: the question it names, by its answer, notice or reply,
 *  is settled, and no other. An older paired Orca names none, so its reply settles the oldest
 *  question still open in its thread. Call it once per stored reply, so a replay settles nothing. */
export function settlePeerQuestionsOut(
  db: OrchestrationDb,
  conversationId: string,
  reply: Pick<z.infer<typeof PeerMailRelayPayload>, 'botAnswer' | 'notice' | 'replyTo' | 'threadId'>
): void {
  const named = reply.botAnswer?.requestId ?? reply.notice?.requestId ?? reply.replyTo
  if (named) {
    db.db
      .prepare(
        `UPDATE peer_questions_out SET awaiting = NULL
         WHERE conversation_id = ? AND message_id = ? AND awaiting = 1`
      )
      .run(conversationId, named)
  } else if (reply.threadId) {
    db.db.prepare(SETTLE_OLDEST_IN_THREAD_SQL).run(conversationId, reply.threadId)
  }
}

// awaiting: 1 while open, NULL once settled, 0 once a reply that named no question settled it.
// idx_peer_questions_out_thread keys (conversation_id, thread key, awaiting), so both read one seek.
const SETTLE_OLDEST_IN_THREAD_SQL = `UPDATE peer_questions_out SET awaiting = 0
  WHERE rowid = (
    SELECT rowid FROM peer_questions_out
    WHERE conversation_id = ?1 AND COALESCE(thread_id, message_id) = ?2 AND awaiting = 1
    ORDER BY rowid LIMIT 1
  )`
const THREAD_SETTLED_UNNAMED_SQL = `SELECT 1 FROM peer_questions_out
  WHERE conversation_id = ?1 AND COALESCE(thread_id, message_id) = ?2 AND awaiting = 0 LIMIT 1`

/** Tells each asker still waiting on that computer that no answer will come: it was removed (no
 *  `server`), or re-paired, so questions sent under an older pairing are lost with it. */
export function tellUnpairedPeerQuestions(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  params: { environmentId: string } &
    // `currentPairing` keeps the questions sent under it, as a re-paired server's pairing does.
    (
      | { serverName: string; reason: string; currentPairing?: string }
      | { server: OrchestrationWorkerServer }
    )
): void {
  const { serverName, reason, pairing } =
    'server' in params
      ? {
          serverName: params.server.name,
          reason: `The pairing with ${params.server.name} was re-made.`,
          pairing: peerMailPairing(params.server)
        }
      : { ...params, pairing: params.currentPairing ?? null }
  const waiting = db.db
    .prepare(
      `SELECT message_id, conversation_id, asker, thread_id FROM peer_questions_out
       WHERE environment_id = ?1 AND awaiting = 1 AND (?2 IS NULL OR peer_fingerprint <> ?2)`
    )
    .all(params.environmentId, pairing)
  let anyTold = false
  for (const row of waiting) {
    const id = String(row.message_id)
    const threadKey = typeof row.thread_id === 'string' ? row.thread_id : id
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
        body: maybeAnswered(db, String(row.conversation_id), threadKey)
          ? `${reason} Your question ${id} there may already be answered. Check the replies in this thread, or ask again.`
          : `${reason} Your question ${id} there will not be answered. Decide without it, or ask again.`,
        threadId: threadKey,
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

/** A reply that named no question settled the oldest open one in this thread, so it may have
 *  answered this one instead. */
function maybeAnswered(db: OrchestrationDb, conversationId: string, threadKey: string): boolean {
  return db.db.prepare(THREAD_SETTLED_UNNAMED_SQL).get(conversationId, threadKey) !== undefined
}
