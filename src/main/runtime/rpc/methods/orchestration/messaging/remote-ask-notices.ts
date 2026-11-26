/** A question a worker on a paired computer asked this Orca's coordinator, under a Run whose
 *  workers that computer runs: the notice goes there the way the answer would, as coordinator mail
 *  to the worker's Dispatch, and its outcome is recorded once the computer has taken it. */

import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { QuestionNoticeWriter } from '../../../../orchestration/mailbox/questions/question-reconcile'
import { getRemoteOwnedQuestion } from '../../../../orchestration/db/remote-owned/remote-dispatch-records'
import { getOpenRemoteRunLink } from '../../../../orchestration/db/remote-owned/remote-run-links'
import { callRemoteOwnedServer } from '../../../../orchestration/federation/remote-owned/remote-owned-calls'
import { isRemoteServerUnreachable } from '../../../../orchestration/federation/remote-owned/remote-server-unreachable'
import { workerAskNoticeText } from './worker-ask-notices'
import { noteQuestionEdge } from '../../../../orchestration/db/messages/question-edges'

const SEND_TIMEOUT_MS = 30_000

/** Notices on their way to a paired computer; a decision while one is out doesn't send it again. */
const sending = new Set<string>()
/** Paired computers a notice couldn't reach: their next successful pull sends it again. */
const unreachable = new Set<string>()

/** A paired computer answered a pull: notices it couldn't take before are decided again. */
export function retryRemoteAskNotices(environmentId: string): void {
  if (unreachable.delete(environmentId)) {
    noteQuestionEdge({ kind: 'reachable', environmentId })
  }
}

function endRemoteAsk(db: OrchestrationDb, messageId: string, ended: 'unanswered' | 'dropped') {
  db.db
    .prepare(
      `UPDATE remote_owned_questions SET ended = ?, awaiting = NULL
       WHERE message_id = ? AND awaiting = 1 AND ended IS NULL`
    )
    .run(ended, messageId)
}

export function remoteAskNotices(
  runtime: Pick<
    OrcaRuntimeService,
    | 'getOrchestrationDb'
    | 'resolveOrchestrationWorkerServer'
    | 'callOrchestrationWorkerServer'
    | 'readMachineName'
    | 'getRuntimeId'
    | 'notifyMessageArrived'
  >,
  taker: string
): QuestionNoticeWriter {
  const db = runtime.getOrchestrationDb()
  const dropped = taker.startsWith('dropped:') ? taker.slice('dropped:'.length) : null
  return ({ messageId }) => {
    const question = getRemoteOwnedQuestion(db, messageId)
    if (!question) {
      return 'told'
    }
    const link = getOpenRemoteRunLink(db, question.conversation_id)
    if (!link) {
      // The computer no longer runs this Run's workers: no notice can reach the worker.
      endRemoteAsk(db, messageId, 'dropped')
      return 'told'
    }
    if (sending.has(messageId)) {
      return 'sending'
    }
    sending.add(messageId)
    // A reset while it was out leaves nothing here to record.
    const ended = (outcome: 'unanswered' | 'dropped') => {
      if (runtime.getOrchestrationDb() === db) {
        endRemoteAsk(db, messageId, outcome)
      }
    }
    // After the decision's write commits; the stable request id makes a resend after a lost
    // receipt return the computer's first one instead of sending the notice twice.
    queueMicrotask(() => {
      void callRemoteOwnedServer(runtime, link, {
        method: 'orchestration.send',
        params: {
          to: `dispatch:${question.dispatch_id}`,
          subject: 'Re: Question',
          body: workerAskNoticeText(question.run_id, dropped ?? 'unanswered'),
          type: 'status',
          threadId: messageId
        },
        timeoutMs: SEND_TIMEOUT_MS,
        requestId: `question-notice:${messageId}`,
        whileLink: ['open']
      })
        .then(() => ended(dropped === null ? 'unanswered' : 'dropped'))
        .catch((error: unknown) => {
          if (isRemoteServerUnreachable(error)) {
            unreachable.add(question.environment_id)
            return
          }
          // The computer refused it: telling again would only be refused again.
          console.warn(
            `[agent-questions] a paired computer refused question ${messageId}'s notice`,
            error
          )
          ended(dropped === null ? 'unanswered' : 'dropped')
        })
        .finally(() => sending.delete(messageId))
    })
    return 'sending'
  }
}
