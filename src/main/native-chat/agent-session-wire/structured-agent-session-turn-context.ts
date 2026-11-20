// What the host adds ahead of a person's words in a turn, beside the conversation's own ride-along.

import type { AgentJournalTurnOpenerRows } from '../../../shared/agent-session/journal/agent-session-journal-turn-opener'
import type {
  AgentJournalMessageItem,
  AgentJournalPlainStatusItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnCompletion } from '../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { JournalSqlReads } from '../agent-session-journal/journal-sql-reads'
import { readJournalTurnOpenerRows } from '../agent-session-journal/journal-turn-opener-rows'

export type StructuredAgentSessionTurnContextPlan = {
  /** Goes ahead of the person's words, before any automation results. */
  text: string
  /** A row for the turn, if any; written, like `given`, only once the agent took the turn. */
  note?: AgentJournalPlainStatusItem
  /** The host-owned instructions key this turn vouches for (it carries their update, or the launch
   *  gave them); recorded on the session once the agent took the turn. */
  instructionsKey?: string
  /** The agent took the turn: what was sent is now what it has. `instructionsRecorded` says whether
   *  `instructionsKey`'s receipt was written; when not, the next turn sends them again. */
  given: (receipt: { instructionsRecorded: boolean }) => void
}

/** The session record's instructions receipt when the turn was planned (null: none, after a reset
 *  or before any); absent when unread. */
type HeldInstructions = string | null | undefined

export type StructuredAgentSessionTurnContext = {
  /** Read at handover of a person's message; null adds nothing. */
  plan: (
    sessionId: string,
    message: AgentJournalMessageItem,
    held?: HeldInstructions
  ) => Promise<StructuredAgentSessionTurnContextPlan | null>
  /** What a launch or a later link left the agent to learn, for a turn `plan` doesn't ride (a
   *  worker's report, an attachment); `plan` carries it on a person's words. Null adds nothing. */
  launchUpdate?: (
    sessionId: string,
    held?: HeldInstructions,
    message?: AgentJournalMessageItem
  ) => Promise<StructuredAgentSessionTurnContextPlan | null>
  /** The host instructions key this session's launch rendered, and whether its start gives them to
   *  any context (an agent that rebuilds its prompt) rather than only a new one. Null: none. */
  launchedInstructions?: (sessionId: string) => { key: string; rebuilt: boolean } | null
  /** What this person's message alone needs said, such as who the bots it names are; rides with
   *  it whatever the turn, attachments too. Null adds nothing. */
  mentions?: (sessionId: string, message: AgentJournalMessageItem) => Promise<string | null>
  /** A person's message started a turn, whether or not it carries the plan (attachments don't). */
  handedOver?: (sessionId: string, message: AgentJournalMessageItem) => void
  /** A turn in this conversation ended, whoever started it; `readItems` reads its journal. */
  turnEnded?: (
    sessionId: string,
    /** The ended request's turn id, as its completion names it (a turn row's `turnId`). */
    turnId: string,
    /** The ended turn's rows and prompt and every row after `since`, through the head, with their
     *  turns' openers resolved; never the whole journal. */
    readItems: (since: number | null) => Promise<TurnEndedRows>,
    /** Writes a note into the conversation for its clients; the same id again revises it. */
    writeNote?: (clientMessageId: string, body: AgentJournalPlainStatusItem) => Promise<void>,
    /** How the turn ended, as its completion says. */
    ended?: TurnEndedVerdict
  ) => void
}

export type TurnEndedVerdict = Pick<AgentSessionTurnCompletion, 'outcome'>

/** A turn end's rows, and the journal's head when they were read (absent: their newest row's). */
export type TurnEndedRows = AgentJournalTurnOpenerRows & { head?: number }

/** `turnEnded`'s `readItems`: a bounded window even on a chat's first end, whatever the chat holds. */
export async function readTurnEndedItems(
  reads: Pick<JournalSqlReads, 'operationWindow' | 'canonicalItemIds'>,
  turnId: string,
  since: number | null
): Promise<TurnEndedRows> {
  const { snapshot } = await reads.operationWindow({
    ...(since === null ? {} : { afterSequence: since }),
    turnIds: [turnId],
    anchorsOnly: true,
    withoutTurnAhead: true,
    withoutToolOutput: true
  })
  return {
    ...(await readJournalTurnOpenerRows(reads, snapshot.items)),
    head: snapshot.cursor.sequence
  }
}
