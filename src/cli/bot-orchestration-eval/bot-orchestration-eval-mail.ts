// The stand-in's mail: what `check` hands the bot, sends to workers (a finished one continues in a
// follow-up), and replies to a worker's question, in the runtime's shapes.
import { RuntimeClientError } from '../runtime/connection/types'
import { pairedServerSendRefusal } from '../../main/runtime/orchestration/paired-server-follow-up-refusal'
import type { EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import {
  addWorker,
  EVAL_RUN_ID,
  readyReceipt,
  settleWorker,
  workerOrThrow,
  type StandInWorker
} from './bot-orchestration-eval-workers'

/** A message as the runtime stores and `check` returns it. */
export type StandInMessage = {
  id: string
  from_handle: string
  to_handle?: string
  type: string
  subject: string
  body: string
  thread_id?: string | null
  payload?: string | null
}
/** Where a send landed: the Dispatch that reads it (followUpOf: the one addressed, when that one
 *  was continued), or why it was refused. */
export type SendVerdict =
  | { delivered: true; dispatchId: string; followUpOf?: string }
  | { delivered: false; error: string }
// The runtime's receipt `next` line for an answered question.
const FINISH_MAILBOX = 'Finish the rest of your mail.'

/** Mail for the bot's run; a worker_done in it settles that worker first. */
export function queueMail(state: EvalHostState, mail: StandInMessage[]): void {
  for (const message of mail) {
    if (message.type === 'worker_done') {
      const payload = JSON.parse(message.payload ?? '{}')
      settleWorker(state, payload.dispatchId, payload.outcome === 'failed' ? 'failed' : 'succeeded')
    }
  }
  state.mail = [...(state.mail ?? []), ...mail]
}
export function check(state: EvalHostState, params: Record<string, unknown>) {
  const mail = state.mail ?? []
  const empty = {
    runId: EVAL_RUN_ID,
    deliveryId: null,
    messages: [],
    count: 0,
    replayed: false,
    acknowledged: null,
    timedOut: false,
    cancelled: false,
    connectionLost: false
  }
  // A plain check takes the mail it shows; --peek and --all leave it unread.
  if (params.peek || params.all) {
    return { ...empty, messages: mail, count: mail.length }
  }
  if (mail.length === 0 || (params.ack && !params.wait)) {
    return empty
  }
  state.mail = []
  state.read = [...(state.read ?? []), ...mail]
  return {
    ...empty,
    deliveryId: `delivery_${(state.read ?? []).length}`,
    messages: mail,
    count: mail.length,
    deliveryAcknowledged: true
  }
}

function message(to: string, params: Record<string, unknown>, id: string): StandInMessage {
  return {
    id,
    from_handle: `run:${EVAL_RUN_ID}`,
    to_handle: to,
    type: String(params.type ?? 'status'),
    subject: String(params.subject ?? ''),
    body: String(params.body ?? ''),
    thread_id: typeof params.threadId === 'string' ? params.threadId : null,
    payload: null
  }
}

function resolveRecipient(state: EvalHostState, to: string): StandInWorker {
  if (to.startsWith('dispatch:')) {
    return workerOrThrow(state, to.slice('dispatch:'.length))
  }
  if (to.startsWith('task:')) {
    throw new RuntimeClientError('invalid_argument', 'Send to a Dispatch or run, not a Task.')
  }
  const byHandle = (state.workers ?? []).filter((worker) => worker.terminalHandle === to)
  if (!byHandle[0]) {
    throw new RuntimeClientError(
      'terminal_not_found',
      `Terminal ${to} has no live pane or durable Run/Dispatch mailbox.`
    )
  }
  return byHandle.at(-1)!
}

// A finished local worker continues in a follow-up: in place while its terminal is open, reopened
// in its saved conversation once it closed. A paired server cannot continue one yet.
export function send(state: EvalHostState, params: Record<string, unknown>) {
  const to = String(params.to ?? '')
  if (!params.subject) {
    throw new RuntimeClientError('invalid_argument', 'Missing --subject')
  }
  const sentId = `msg_sent_${(state.sent ?? []).length + 1}`
  if (to === `run:${EVAL_RUN_ID}`) {
    return { receipt: { message: message(to, params, sentId) }, verdict: null }
  }
  const addressed = resolveRecipient(state, to)
  // A worker continued before is addressed through its latest continuation.
  const worker = latestContinuation(state, addressed)
  const continued = worker === addressed ? {} : { followUpOf: addressed.dispatchId }
  if (worker.state === 'ready') {
    ;(state.sent ??= []).push(message(`dispatch:${worker.dispatchId}`, params, sentId))
    return {
      receipt: { message: message(`dispatch:${worker.dispatchId}`, params, sentId) },
      verdict: {
        delivered: true,
        dispatchId: worker.dispatchId,
        ...continued
      } satisfies SendVerdict
    }
  }
  if (worker.server) {
    throw new RuntimeClientError(
      'dispatch_inactive',
      pairedServerSendRefusal(worker.dispatchId, worker.server, worker.state)
    )
  }
  const type = String(params.type ?? 'status')
  if (!['status', 'dispatch', 'handoff'].includes(type) || !worker.worktreeId) {
    throw new RuntimeClientError(
      'dispatch_inactive',
      `Dispatch ${worker.dispatchId} is ${worker.state}; its worker will never read that mailbox. Send to run:${EVAL_RUN_ID} instead, or start a new Dispatch for follow-up work.`
    )
  }
  const followUp = addWorker(state, {
    worktreeId: worker.worktreeId,
    agent: worker.agent,
    spec: params.body ?? params.subject,
    state: 'ready',
    terminal: 'active',
    followUpOf: worker.dispatchId
  })
  ;(state.sent ??= []).push(message(`dispatch:${followUp.dispatchId}`, params, sentId))
  return {
    receipt: {
      ...readyReceipt(followUp, []),
      delivery: worker.terminal === 'active' ? 'follow_up' : 'reopened',
      followUpOf: worker.dispatchId
    },
    verdict: {
      delivered: true,
      dispatchId: followUp.dispatchId,
      followUpOf: addressed.dispatchId
    } satisfies SendVerdict
  }
}

function latestContinuation(state: EvalHostState, worker: StandInWorker): StandInWorker {
  const next = (state.workers ?? []).find((entry) => entry.followUpOf === worker.dispatchId)
  return next ? latestContinuation(state, next) : worker
}

export function reply(state: EvalHostState, params: Record<string, unknown>) {
  const id = String(params.id ?? '')
  const original = [...(state.read ?? []), ...(state.mail ?? [])].find((entry) => entry.id === id)
  if (!original) {
    throw new RuntimeClientError('runtime_error', `Message not found: ${id}`)
  }
  const answer = {
    ...message(original.from_handle, { subject: `Re: ${original.subject}`, body: params.body }, ''),
    id: `msg_answer_${id}`,
    thread_id: original.thread_id ?? original.id
  }
  const answered = (state.sent ?? []).some((entry) => entry.id === answer.id)
  if (!answered) {
    ;(state.sent ??= []).push(answer)
  }
  return original.type === 'question'
    ? {
        message: answer,
        question: { message_id: id, status: 'answered', answer_body: answer.body },
        duplicate: answered,
        next: FINISH_MAILBOX
      }
    : { message: answer }
}
