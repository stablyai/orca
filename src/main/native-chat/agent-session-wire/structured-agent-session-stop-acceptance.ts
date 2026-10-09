// A Stop accepts through its own command receipt BEFORE it acts: the receipt, and for the chat's
// Stop its event and every send it holds, commit first, and only then does it interrupt or end
// anything. A Stop whose acceptance cannot be saved acts on nothing and says so; a retry of its id
// is answered from the receipt and never resolves a target again.

import { refuse, type AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import {
  isAgentSessionRefusalError,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { CommandReceiptResult } from '../agent-session-journal/command-receipt-schema'
import { CommandReceiptExistsError } from '../agent-session-journal/command-receipt-transaction'
import {
  classifyJournalOpenFailure,
  isJournalWrittenByNewerOrca,
  journalOpenRefusal
} from '../agent-session-journal/journal-open-failure'
import type {
  JournalStopAcceptance,
  JournalStopAcceptanceInput
} from '../agent-session-journal/journal-stop-acceptance'
import {
  journalRowReceiptResult,
  type MutationCommandReceipt
} from './structured-agent-session-mutation-plans'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

/** What a Stop accepted with no Stop event of its own captured (`CommandReceiptResult` `stop`). */
export type StructuredAgentSessionStopTarget = Omit<
  Extract<CommandReceiptResult, { kind: 'stop' }>,
  'kind'
>

/** One Stop's acceptance: the target its receipt records when no Stop event of its own does, and
 *  whether it is saved, so a later step of the same Stop never saves it twice. */
export type StructuredAgentSessionStopAcceptance = {
  target?: StructuredAgentSessionStopTarget
  saved?: true
}

/** The receipt a Stop accepts with: its Stop event, else its captured target; a Stop that acted
 *  on nothing records the no-op it answered, before that answer goes out. */
export function stopCommandReceipt(
  acceptance: StructuredAgentSessionStopAcceptance
): MutationCommandReceipt<AgentSessionCancelResult> {
  return {
    result: (row) => {
      if (row) {
        return journalRowReceiptResult(row, 'tombstone')
      }
      if (!acceptance.target) {
        throw new Error('an accepted Stop requires its event or its target')
      }
      return { kind: 'stop', ...acceptance.target }
    },
    unwritten: (value) => ({
      kind: 'no-op',
      outcome: {
        kind: 'cancel',
        cancelled: false,
        ...(value.turnId !== undefined ? { turnId: value.turnId } : {})
      }
    })
  }
}

type Accepted<T> = { ok: true; value: T } | { ok: false; refusal: AgentSessionWireRefusal }

/** Commits the receipt alone, naming `target`, before a Stop that writes no Stop event acts. */
export async function acceptStopTarget(
  ctx: AgentSessionTurnContext,
  acceptance: StructuredAgentSessionStopAcceptance,
  target: StructuredAgentSessionStopTarget
): Promise<Accepted<null>> {
  const receipt = ctx.operationReceipt
  if (acceptance.saved || !receipt) {
    return { ok: true, value: null }
  }
  acceptance.target = target
  try {
    await ctx.journal.stops.commitReceipt(receipt)
    acceptance.saved = true
    return { ok: true, value: null }
  } catch (error) {
    return notAccepted(ctx, error)
  }
}

/** Commits the chat's Stop: the sends it holds, its event and its receipt, in one transaction. */
export async function acceptChatStop(
  ctx: AgentSessionTurnContext,
  acceptance: StructuredAgentSessionStopAcceptance,
  input: JournalStopAcceptanceInput
): Promise<Accepted<JournalStopAcceptance>> {
  try {
    const accepted = await ctx.journal.stops.accept(
      input,
      acceptance.saved ? undefined : ctx.operationReceipt
    )
    acceptance.saved = true
    return { ok: true, value: accepted }
  } catch (error) {
    return notAccepted(ctx, error)
  }
}

/** Nothing was saved, so nothing is interrupted: the agent keeps running and the person is told
 *  to try again. A receipt another call committed first answers this one instead. */
function notAccepted(ctx: AgentSessionTurnContext, error: unknown): Accepted<never> {
  if (error instanceof CommandReceiptExistsError) {
    throw error
  }
  ctx.logger.warn('saving a Stop failed; the agent was not interrupted', {
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
  const agent = isTuiAgent(ctx.agent) ? TUI_AGENT_DISPLAY_NAMES[ctx.agent] : 'the agent'
  return {
    ok: false,
    refusal: refuse(
      'agent_session_operation_invalid',
      { reason: 'journalWriteFailed' },
      `Couldn't stop ${agent}. Try again.`
    )
  }
}
