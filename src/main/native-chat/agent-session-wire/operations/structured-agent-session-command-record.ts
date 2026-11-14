import type { AgentSessionReviewTarget } from '../../../../shared/agent-session/agent-session-review-target'
import {
  agentSessionCompactCommandText,
  type AgentSessionConversationCommand
} from '../../../../shared/agent-session/agent-session-conversation-command'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { StructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-current-work'
import { structuredAgentSessionCommandTurn } from '../../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
export const STRUCTURED_AGENT_SESSION_COMPACT_COMMAND = 'compact'

export function structuredAgentSessionCompactBody(
  instructions?: string,
  name: AgentSessionConversationCommand = 'compact',
  review?: AgentSessionReviewTarget
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      {
        type: 'text',
        text:
          name === 'review'
            ? `/review${instructions ? ` ${instructions}` : ''}`
            : agentSessionCompactCommandText(instructions)
      }
    ],
    command: {
      name,
      ...(review ? { review } : {}),
      ...(instructions ? { instructions } : {})
    }
  }
}

type AwaitedSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'acceptedSequence'
>

export type StructuredAgentSessionAwaitedCommandJournal = {
  inputOrder?: Pick<AgentSessionJournal['inputOrder'], 'recoverableSubmissions'>
  submissions?: () => readonly AwaitedSubmission[]
  itemBody: AgentSessionJournal['itemBody']
}

/** Find the oldest awaited command so failed starts preserve the command for explicit retry. */
export function structuredAgentSessionAwaitedCommand(
  journal: StructuredAgentSessionAwaitedCommandJournal
): AgentSessionConversationCommand | undefined {
  let oldest: AwaitedSubmission | undefined
  for (const submission of journal.inputOrder?.recoverableSubmissions() ??
    journal.submissions?.() ??
    []) {
    if (
      submission.dispatchState === 'pending' &&
      (oldest === undefined || (submission.acceptedSequence ?? 0) < (oldest.acceptedSequence ?? 0))
    ) {
      oldest = submission
    }
  }
  const body = oldest && journal.itemBody(agentJournalSubmissionKey(oldest.clientMessageId))
  return body?.kind === 'message' &&
    (body.command?.name === 'compact' || body.command?.name === 'review')
    ? body.command.name
    : undefined
}

/** Command turns refuse input while their child runs. */
export function structuredAgentSessionCommandRunning(
  work: Pick<StructuredAgentSessionCurrentWork, 'activeTurnId'>
): boolean {
  const turnId = work.activeTurnId()
  return turnId !== null && isStructuredAgentSessionCommandTurnId(turnId)
}

export function isStructuredAgentSessionCommandTurnId(turnId: string): boolean {
  return turnId.startsWith('compact:')
}

const STOP_NOTE_PREFIX = 'stop:'

export function structuredAgentSessionStopNoteIdentity(stopKey: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `${STOP_NOTE_PREFIX}${stopKey}` }
}

export function isStructuredAgentSessionStopNote(itemId: string): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && identity.clientMessageId.startsWith(STOP_NOTE_PREFIX)
}

/** Read Stop from the journal so cached state cannot outlive the command. */
export function structuredAgentSessionCommandWasStopped(
  journal: Pick<AgentSessionJournal, 'itemsRead'>,
  turnId: string
): boolean {
  const { itemId } = structuredAgentSessionCommandTurn(turnId.slice('compact:'.length))
  return journal
    .itemsRead()
    .items.some(
      (item) =>
        item.turnScope?.kind === 'turn' &&
        item.turnScope.turnItemId === itemId &&
        isStructuredAgentSessionStopNote(item.itemId)
    )
}
