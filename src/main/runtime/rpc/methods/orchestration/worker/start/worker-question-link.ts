// `worker-start --for <question>`: the question a worker is started to answer, linked only when the
// caller took it or reads the mailbox it sits in. A start is never refused for this: an unlinked
// worker still starts, and the receipt says why it isn't linked.
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { hasRunBindingKey } from '../../../../../orchestration/addressing/orchestration-caller-identity'
import {
  callerMailTaker,
  getQuestionTaker,
  mailTakerKey,
  sessionMailTaker,
  stampQuestionTakes
} from '../../../../../orchestration/db/messages/mail-taker'

export type WorkerQuestionLink =
  | { question: string; linked: true; take?: () => void }
  | { question: string; linked: false; why: string }

export function linkWorkerToQuestion(
  db: OrchestrationDb,
  question: string,
  caller: OrchestrationCallerIdentity | null,
  paired: boolean
): WorkerQuestionLink {
  const unlinked = (why: string): WorkerQuestionLink => ({ question, linked: false, why })
  if (!caller) {
    return unlinked("Orca can't tell which agent is starting this worker")
  }
  if (paired) {
    return unlinked("a worker on a paired computer can't be linked to a question")
  }
  const message = db.getMessageById(question)
  const asked =
    message?.type === 'question' &&
    (db.getBotRequest(question)?.purpose === 'question' ||
      db.getQuestionRaw(question) !== undefined)
  if (!message || !asked) {
    return unlinked(`${question} is not a question this Orca holds`)
  }
  const taker = callerMailTaker(caller)
  const takenBy = getQuestionTaker(db, question)
  if (takenBy !== null) {
    // A structured worker reads chat cards as its session and checks mail as its terminal.
    const own = [taker, ...(caller.orcaSessionId ? [sessionMailTaker(caller.orcaSessionId)] : [])]
    return own.some((mine) => mailTakerKey(mine) === takenBy)
      ? { question, linked: true }
      : unlinked(`${question} was taken by someone else`)
  }
  if (message.read === 1) {
    return unlinked(`${question} was read before Orca recorded who took it`)
  }
  const mailboxes = new Set([
    caller.address,
    ...(hasRunBindingKey(caller)
      ? db.runsBoundToCoordinator(caller).map((run) => `run:${run.id}`)
      : [])
  ])
  if (!mailboxes.has(message.to_handle)) {
    return unlinked(`${question} was not sent to you`)
  }
  // The start can come before the delivery that hands it over; the take is recorded once it starts.
  return { question, linked: true, take: () => stampQuestionTakes(db, [question], taker) }
}
