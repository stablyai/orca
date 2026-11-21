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
import { botRequestRecord } from '../../messaging/bot-request-record'
import { botRequestSenderName } from '../../../../../../bots/bot-request-view'

export type WorkerQuestionLink =
  | {
      question: string
      linked: true
      /** Records the take once the start produced a worker; the link holds only if the caller has it. */
      take?: (started: boolean) => WorkerQuestionLink
    }
  | { question: string; linked: false; why: string }

// A structured worker reads chat cards as its session and checks mail as its terminal.
function ownTakerKeys(caller: OrchestrationCallerIdentity): string[] {
  return [
    callerMailTaker(caller),
    ...(caller.orcaSessionId ? [sessionMailTaker(caller.orcaSessionId)] : [])
  ].map(mailTakerKey)
}

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
  const own = ownTakerKeys(caller)
  const takenByCaller = (takenBy: string) => own.includes(takenBy)
  const takenBy = getQuestionTaker(db, question)
  if (takenBy !== null) {
    return takenByCaller(takenBy)
      ? { question, linked: true }
      : unlinked(`${question} was taken by someone else`)
  }
  if (message.read === 1) {
    return unlinked(`${question} was read before Orca recorded who took it`)
  }
  const ownDispatch = caller.terminalHandle
    ? db.getActiveDispatchForIdentity(caller.terminalHandle, caller.paneKey ?? undefined)
    : undefined
  const mailboxes = new Set([
    caller.address,
    ...(ownDispatch ? [`dispatch:${ownDispatch.id}`] : []),
    ...(hasRunBindingKey(caller)
      ? db.runsBoundToCoordinator(caller).map((run) => `run:${run.id}`)
      : [])
  ])
  if (!mailboxes.has(message.to_handle)) {
    return unlinked(`${question} was not sent to you`)
  }
  // The start can come before the delivery that hands it over; the take is recorded once it starts.
  return {
    question,
    linked: true,
    take: (started) => {
      if (!started) {
        return unlinked(`no worker started for ${question}`)
      }
      stampQuestionTakes(db, [question], taker)
      const after = getQuestionTaker(db, question)
      return after !== null && takenByCaller(after)
        ? { question, linked: true }
        : unlinked(`${question} was taken by someone else while the worker started`)
    }
  }
}

/** The start receipt with its `--for` outcome; a start that produced no worker takes nothing. */
export function withQuestionLink<T>(link: WorkerQuestionLink | undefined, started: T): T {
  if (!link || !started || typeof started !== 'object') {
    return started
  }
  const workerStarted = !('state' in started) || started.state !== 'failed'
  const forQuestion: WorkerQuestionLink = !link.linked
    ? link
    : (link.take?.(workerStarted) ?? { question: link.question, linked: true })
  return { ...started, forQuestion }
}

/** For a start without `--for`: the newest question the caller took and hasn't answered, so it can
 *  link the worker to it. A caller with no open question gets nothing. */
export function openQuestionReminder(
  db: OrchestrationDb,
  caller: OrchestrationCallerIdentity | null
): string | undefined {
  const own = caller ? ownTakerKeys(caller) : []
  if (own.length === 0) {
    return undefined
  }
  const id = db.db
    .prepare(
      `SELECT message_id FROM bot_requests WHERE awaiting = 1
       AND taken_by IN (${own.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT 1`
    )
    .get(...own)?.message_id
  if (typeof id !== 'string') {
    return undefined
  }
  const record = botRequestRecord(db, id)
  const asker = record ? botRequestSenderName(record) : 'another agent'
  return `You have an open question from ${asker} (${id}). If this worker is for it, add --for ${id}.`
}

/** The start receipt with the caller's open-question reminder, when it has one. */
export function withOpenQuestion<T>(reminder: string | undefined, started: T): T {
  return reminder && started && typeof started === 'object'
    ? { ...started, openQuestion: reminder }
    : started
}
