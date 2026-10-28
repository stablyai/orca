// Commit Stop receipt/effects before interrupting; failed acceptance acts on nothing and retries never retarget.

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
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import {
  journalRowReceiptResult,
  type MutationCommandReceipt
} from './structured-agent-session-mutation-plans'
import type {
  AgentSessionOperationReceipt,
  AgentSessionTurnContext
} from './structured-agent-session-turns'

/** Preserve the first committed result, including no-op; later failures answer from that receipt. */
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

/** Save standalone acceptance before effects that write no row. */
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

/** Atomically commit withdrawals, event and receipt; null turnId means the turn could not be read. */
export async function acceptChatStop(
  ctx: AgentSessionTurnContext,
  input: Omit<JournalStopAcceptanceInput, 'liveTurnId'>
): Promise<Accepted<{ turnId: string | null; withdrawn?: string[] }>> {
  const receipt = stopReceipt(ctx)
  const committedBefore = receipt.isCommitted()
  try {
    const accepted = await ctx.journal.stops.accept(
      { ...input, liveTurnId: () => contextStructuredAgentSessionCurrentWork(ctx).activeTurnId() },
      committedBefore ? undefined : receipt
    )
    return { ok: true, value: { turnId: accepted.turnId, withdrawn: accepted.withdrawn } }
  } catch (error) {
    return savedAnyway(ctx, receipt, committedBefore, error)
      ? { ok: true, value: { turnId: null } }
      : stopNotSaved(ctx, error)
  }
}

/** Post-COMMIT fold failure cannot undo acceptance; act on the saved capture. */
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

function stopReceipt(ctx: AgentSessionTurnContext): AgentSessionOperationReceipt {
  if (!ctx.operationReceipt) {
    throw new Error('a Stop is accepted only through its command receipt')
  }
  return ctx.operationReceipt
}

export function cardCancelNotSavedRefusal(): AgentSessionWireRefusal {
  return refuse(
    'agent_session_operation_invalid',
    { reason: 'cancelNotSaved' },
    `${AGENT_SESSION_WRITE_NOTICE_COPY.cancelNotSaved} ${AGENT_SESSION_WRITE_NOTICE_COPY.tryAgain}`
  )
}

/** Failed save interrupts nothing; an earlier committed receipt answers competing retries. */
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
  // Match journal-open refusals for corruption, newer data and typed journal errors.
  if (
    isAgentSessionRefusalError(error) ||
    classifyJournalOpenFailure(error) === 'journalCorrupt' ||
    isJournalWrittenByNewerOrca(error)
  ) {
    return { ok: false, refusal: journalOpenRefusal(error) }
  }
  return { ok: false, refusal: notSaved.refusal() }
}
