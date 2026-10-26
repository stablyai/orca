/** Use the composer's structured send/envelope/waiter or the terminal prompt writer; callers interpret the shared outcome. */

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
import type { RuntimeAgentPromptWriteOptions } from '../runtime-terminal-contracts'

/** now steers a running turn; queue holds busy-chat input until its turn ends. */
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
  /** Host-local admission for an automated send. */
  beforeRun?: () => void
  /** Host-local: a background notice carries no changed user choices. */
  keepCurrentOptions?: true
}

export type StructuredSessionTurnSend = {
  kind: 'structured-session'
  host: StructuredAgentTurnHost
  sessionId: string
  /** Scopes the host's operation ledger, so one sender's sends cannot exhaust another's budget. */
  callerKey: string
  turn: StructuredSessionTurn
  /** The caller's own readiness budget for the agent to take the message, its start included;
   *  the orchestration readiness timeout by default. */
  budgetMs?: number
}

/** Only Dispatch preambles lead with coordinator task text; external messages use the user-input route. */
export type TerminalTurnPurpose = 'dispatch-preamble' | 'external-message'

/** A terminal has one write: whether a mid-turn prompt waits is the agent TUI's own behaviour. */
export type TerminalTurn = {
  purpose: TerminalTurnPurpose
  body: string
  /** The request id the write's receipt is correlated on. */
  operationId: string
}

/** The writer's opt-in options a terminal turn may carry; no current caller sets them. */
type TerminalTurnWriteOptions = Pick<
  RuntimeAgentPromptWriteOptions,
  'signal' | 'onPermission' | 'expectedBinding'
>

/** Method syntax on purpose: the runtime's own signature takes the wider write options. */
type TerminalAgentTurnRuntime<TReceipt> = {
  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: DispatchPreambleSendOptions & TerminalTurnWriteOptions
  ): Promise<TReceipt>
}

export type TerminalTurnSend<TReceipt> = {
  kind: 'terminal'
  runtime: TerminalAgentTurnRuntime<TReceipt>
  handle: string
  turn: TerminalTurn
  /** Runs before each PTY write; throwing refuses it (`createWorkerBriefWriteGuard`). */
  beforeWrite?: DispatchPreambleSendOptions['beforeWrite']
} & TerminalTurnWriteOptions

/** sent may have no proven submission or remain pending; queued reports the host's current draft, including replay settlement. */
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
        ...(send.beforeWrite ? { beforeWrite: send.beforeWrite } : {}),
        ...(send.signal ? { signal: send.signal } : {}),
        ...(send.onPermission ? { onPermission: send.onPermission } : {}),
        ...(send.expectedBinding ? { expectedBinding: send.expectedBinding } : {})
      })
  }
}

function terminalTurnOptions(turn: TerminalTurn): DispatchPreambleSendOptions {
  switch (turn.purpose) {
    case 'dispatch-preamble':
      return dispatchPreambleSendOptions(turn.operationId)
    case 'external-message':
      // The writer returning is the whole receipt; the turn is read from hooks, not awaited here.
      return {
        inputKind: 'orchestration',
        acceptQueued: true,
        observationTimeoutMs: 0,
        requestId: turn.operationId
      }
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
  const result = await send.host.send(
    { callerKey: send.callerKey },
    { ...message, beforeRun: turn.beforeRun, keepCurrentOptions: turn.keepCurrentOptions }
  )
  if (!result.ok) {
    return { kind: 'refused', refusal: result.refusal }
  }
  const { clientMessageId } = result.value
  if ('queued' in result.value) {
    return { kind: 'queued', clientMessageId, queued: result.value.queued }
  }
  // Admission is not delivery; one caller budget covers startup and settlement, leaving overdue submissions pending.
  const answered = agentSessionSendSubmission(result.value)
  if (answered?.dispatchState !== 'pending') {
    return { kind: 'sent', clientMessageId, submission: answered }
  }
  // Wait on the answered id: replayed queued drafts may have dispatched under a new id.
  const settled = await send.host
    .waitForSendSettlement(send.sessionId, answered.clientMessageId, {
      budgetMs: send.budgetMs ?? ORCHESTRATION_READINESS_TIMEOUT_MS
    })
    .catch(() => undefined)
  return {
    kind: 'sent',
    clientMessageId,
    submission: agentSessionSendSubmission(settled?.value) ?? answered
  }
}
