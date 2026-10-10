// A Stop accepts through its own command receipt BEFORE it acts: the receipt, and for the chat's
// Stop its event and every send it settles, commit first, and only then does it interrupt or end
// anything. A Stop whose acceptance cannot be saved acts on nothing and says so. A retry of its id
// is answered from the receipt and never resolves a target again.

import { agentSessionFailureSentence } from '../../../shared/agent-session-failure-words'
import { refuse, type AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import {
  isAgentSessionRefusalError,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../shared/agent-session-write-notice-copy'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { CommandReceiptExistsError } from '../agent-session-journal/command-receipt-transaction'
import {
  classifyJournalOpenFailure,
  isJournalWrittenByNewerOrca,
  journalOpenRefusal
} from '../agent-session-journal/journal-open-failure'
import type { JournalStopAcceptanceInput } from '../agent-session-journal/journal-stop-acceptance'
import {
  journalRowReceiptResult,
  type MutationCommandReceipt
} from './structured-agent-session-mutation-plans'
import type {
  AgentSessionOperationReceipt,
  AgentSessionTurnContext
} from './structured-agent-session-turns'

/** The receipt a Stop accepts with: the row it wrote (its Stop event, or a card's dismissal), else
 *  that it was accepted. A Stop that acted on nothing records the no-op it answered. Once committed
 *  it is never rewritten: a failure after it is answered from it. */
export const STOP_COMMAND_RECEIPT: MutationCommandReceipt<AgentSessionCancelResult> = {
  result: (row) => (row ? journalRowReceiptResult(row, 'tombstone', 'item') : { kind: 'stop' }),
  unwritten: (value) => ({
    kind: 'no-op',
    outcome: {
      kind: 'cancel',
      cancelled: false,
      ...(value.turnId !== undefined ? { turnId: value.turnId } : {})
    }
  })
}

/** What a Stop that could not be saved answers: plain words naming the agent, and to try again. */
export function stopFailedRefusal(
  ctx: Pick<AgentSessionTurnContext, 'agent'>
): AgentSessionWireRefusal {
  const agent = isTuiAgent(ctx.agent) ? ctx.agent : undefined
  const words = agentSessionFailureSentence(
    { kind: 'stopFailed' },
    'row',
    agent ? { agentName: TUI_AGENT_DISPLAY_NAMES[agent] } : {}
  )
  return refuse(
    'agent_session_operation_invalid',
    { reason: 'stopFailed', ...(agent ? { agent } : {}) },
    `${words} Try again.`
  )
}

type Accepted<T> = { ok: true; value: T } | { ok: false; refusal: AgentSessionWireRefusal }

/** Commits the receipt alone, before a Stop that writes no row of its own acts. */
export async function acceptStopTarget(ctx: AgentSessionTurnContext): Promise<Accepted<null>> {
  const receipt = stopReceipt(ctx)
  const committedBefore = receipt.isCommitted()
  try {
    await receipt.commitAlone()
  } catch (error) {
    if (!savedAnyway(ctx, receipt, committedBefore, error)) {
      return stopNotSaved(ctx, error)
    }
  }
  return { ok: true, value: null }
}

/** Commits the chat's Stop: the sends it withdraws, its event and its receipt, in one transaction.
 *  `turnId`: the turn its event names, null when that went unread. */
export async function acceptChatStop(
  ctx: AgentSessionTurnContext,
  input: JournalStopAcceptanceInput
): Promise<Accepted<{ turnId: string | null }>> {
  const receipt = stopReceipt(ctx)
  const committedBefore = receipt.isCommitted()
  try {
    const accepted = await ctx.journal.stops.accept(input, committedBefore ? undefined : receipt)
    return { ok: true, value: { turnId: accepted.turnId } }
  } catch (error) {
    return savedAnyway(ctx, receipt, committedBefore, error)
      ? { ok: true, value: { turnId: null } }
      : stopNotSaved(ctx, error)
  }
}

/** A throw once this write committed the receipt (the fold after COMMIT) leaves the Stop accepted:
 *  it acts on what it saved, and is never answered as not saved. */
function savedAnyway(
  ctx: AgentSessionTurnContext,
  receipt: AgentSessionOperationReceipt,
  committedBefore: boolean,
  error: unknown
): boolean {
  if (committedBefore || !receipt.isCommitted()) {
    return false
  }
  ctx.logger.warn('a Stop was saved, then its write failed; it acts on what it saved', {
    scope: 'stop-acceptance',
    sessionId: ctx.sessionId,
    error
  })
  return true
}

/** Every Stop accepts through its command receipt; one without it is a plan wired wrong. */
function stopReceipt(ctx: AgentSessionTurnContext): AgentSessionOperationReceipt {
  if (!ctx.operationReceipt) {
    throw new Error('a Stop is accepted only through its command receipt')
  }
  return ctx.operationReceipt
}

/** What a card's Cancel whose dismissal could not be saved answers: words about the card. */
export function cardCancelNotSavedRefusal(): AgentSessionWireRefusal {
  return refuse(
    'agent_session_operation_invalid',
    { reason: 'cancelNotSaved' },
    `${AGENT_SESSION_WRITE_NOTICE_COPY.cancelNotSaved} ${AGENT_SESSION_WRITE_NOTICE_COPY.tryAgain}`
  )
}

/** Nothing was saved, so nothing is interrupted: the agent keeps running and the person is told
 *  to try again. A receipt another call committed first answers this one instead. */
export function stopNotSaved(
  ctx: Pick<AgentSessionTurnContext, 'agent' | 'logger' | 'sessionId'>,
  error: unknown,
  notSaved: { log: string; refusal: () => AgentSessionWireRefusal } = {
    log: 'saving a Stop failed; the agent was not interrupted',
    refusal: () => stopFailedRefusal(ctx)
  }
): Accepted<never> {
  if (error instanceof CommandReceiptExistsError) {
    throw error
  }
  ctx.logger.warn(notSaved.log, {
    scope: 'stop-acceptance',
    sessionId: ctx.sessionId,
    error
  })
  // Damage SQLite proves, a newer Orca's chat or a refusal the journal classified: as an open says.
  if (
    isAgentSessionRefusalError(error) ||
    classifyJournalOpenFailure(error) === 'journalCorrupt' ||
    isJournalWrittenByNewerOrca(error)
  ) {
    return { ok: false, refusal: journalOpenRefusal(error) }
  }
  return { ok: false, refusal: notSaved.refusal() }
}
