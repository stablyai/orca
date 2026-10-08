/**
 * The one way Orca sends a message into an agent on another agent's behalf.
 *
 * Built only from the paths a user's own message already takes: a structured chat gets
 * `host.send` (the composer's `sendStructuredAgentSessionTurn`, queue decision included) with the
 * composer's own envelope builder, and the host's own settlement waiter; a terminal gets
 * `sendTerminalAgentPrompt`. Callers keep their own reading of the outcome; what they share is the
 * send and the wait.
 */

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  agentSessionSendSubmission,
  type AgentSessionQueuedSendReceipt
} from '../../../shared/agent-session-wire'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire-refusals'
import { ORCHESTRATION_READINESS_TIMEOUT_MS } from '../../../shared/orchestration-timing-budgets'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { dispatchPreambleSendOptions, type DispatchPreambleSendOptions } from './preamble'

/**
 * `now` hands the message over at once, joining a running turn as a steer. `queue` asks a busy chat
 * to hold it as a draft its queue sends when the turn ends, as the composer does with queueing on.
 */
export type AgentTurnDelivery = 'queue' | 'now'

/** What a structured send reads of the host. */
export type StructuredAgentTurnHost = Pick<
  StructuredAgentSessionHost,
  'send' | 'waitForSendSettlement'
>

export type StructuredSessionTurn = {
  /** Carries its sender as `from`, which the chat shows and no fingerprint covers. */
  body: AgentJournalMessageItem
  /** Reused on a retry, so the host replays its recorded answer instead of sending twice. */
  operationId: string
  expectedRuntimeFence: number
  delivery: AgentTurnDelivery
  /**
   * False for a `now` send into a turn already running: the agent takes it at its next step, not
   * at a start, so `pending` is already the hand-off and there is no start to wait out.
   */
  awaitsStart?: boolean
}

export type StructuredSessionTurnSend = {
  kind: 'structured-session'
  host: StructuredAgentTurnHost
  sessionId: string
  /** Scopes the host's operation ledger, so one sender's sends cannot exhaust another's budget. */
  callerKey: string
  turn: StructuredSessionTurn
}

/**
 * What the typed text is, which decides how it is typed. A dispatch preamble leads with the
 * coordinator's task line; no other kind of message may borrow that.
 */
export type TerminalTurnPurpose = 'dispatch-preamble'

/** A terminal has one write: whether a mid-turn prompt waits is the agent TUI's own behaviour. */
export type TerminalTurn = {
  purpose: TerminalTurnPurpose
  body: string
  /** The request id the write's receipt is correlated on. */
  operationId: string
}

/** Method syntax on purpose: the runtime's own signature takes the wider write options. */
type TerminalAgentTurnRuntime<TReceipt> = {
  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: DispatchPreambleSendOptions
  ): Promise<TReceipt>
}

export type TerminalTurnSend<TReceipt> = {
  kind: 'terminal'
  runtime: TerminalAgentTurnRuntime<TReceipt>
  handle: string
  turn: TerminalTurn
  /** Runs before each PTY write; throwing refuses it (`createWorkerBriefWriteGuard`). */
  beforeWrite?: DispatchPreambleSendOptions['beforeWrite']
}

/**
 * `sent` carries the submission as it settled, or as first answered when the wait ran out; it is
 * undefined when the host answered with no submission at all, which proves neither outcome.
 * `queued` carries the draft as the host reported it; a replayed id may report it already settled.
 */
export type StructuredSessionTurnOutcome =
  | { kind: 'refused'; refusal: AgentSessionWireRefusal }
  | { kind: 'queued'; clientMessageId: string; queued: AgentSessionQueuedSendReceipt }
  | { kind: 'sent'; clientMessageId: string; submission: AgentJournalSubmission | undefined }

export function sendAgentTurn(
  send: StructuredSessionTurnSend
): Promise<StructuredSessionTurnOutcome>
export function sendAgentTurn<TReceipt>(send: TerminalTurnSend<TReceipt>): Promise<TReceipt>
export function sendAgentTurn<TReceipt>(
  send: StructuredSessionTurnSend | TerminalTurnSend<TReceipt>
): Promise<StructuredSessionTurnOutcome | TReceipt> {
  switch (send.kind) {
    case 'structured-session':
      return sendStructuredSessionTurn(send)
    case 'terminal':
      // Not async: the caller awaits the runtime's own promise.
      return send.runtime.sendTerminalAgentPrompt(send.handle, send.turn.body, {
        ...terminalTurnOptions(send.turn),
        ...(send.beforeWrite ? { beforeWrite: send.beforeWrite } : {})
      })
  }
}

function terminalTurnOptions(turn: TerminalTurn): DispatchPreambleSendOptions {
  switch (turn.purpose) {
    case 'dispatch-preamble':
      return dispatchPreambleSendOptions(turn.operationId)
  }
}

async function sendStructuredSessionTurn(
  send: StructuredSessionTurnSend
): Promise<StructuredSessionTurnOutcome> {
  const { turn } = send
  const message = structuredAgentSessionMessageSendMutation({
    sessionId: send.sessionId,
    clientOperationId: turn.operationId,
    expectedRuntimeFence: turn.expectedRuntimeFence,
    body: turn.body,
    delivery: turn.delivery === 'queue' ? 'queue-if-active' : undefined
  })
  const result = await send.host.send({ callerKey: send.callerKey }, message)
  if (!result.ok) {
    return { kind: 'refused', refusal: result.refusal }
  }
  const { clientMessageId } = result.value
  if ('queued' in result.value) {
    return { kind: 'queued', clientMessageId, queued: result.value.queued }
  }
  // Accepted is not delivered: the agent may still be starting, so wait the start out. A wait
  // that fails or runs out leaves the first answer standing.
  const answered = agentSessionSendSubmission(result.value)
  if (answered?.dispatchState !== 'pending' || turn.awaitsStart === false) {
    return { kind: 'sent', clientMessageId, submission: answered }
  }
  // The submission's own id: a replayed `queue` turn whose draft went out answers with the
  // hand-off, which the queue sent under a fresh id.
  const settled = await send.host
    .waitForSendSettlement(send.sessionId, answered.clientMessageId, {
      budgetMs: ORCHESTRATION_READINESS_TIMEOUT_MS
    })
    .catch(() => undefined)
  return {
    kind: 'sent',
    clientMessageId,
    submission: agentSessionSendSubmission(settled?.value) ?? answered
  }
}
