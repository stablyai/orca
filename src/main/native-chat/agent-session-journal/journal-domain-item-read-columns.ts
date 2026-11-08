import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { currentAgentSessionThreadGoalSourceBySequence } from '../../../shared/agent-session/agent-session-thread-goal'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { claudeAgentRowFacts } from '../../claude/claude-subagent-journaled-identities'

/** journal_items columns the direct item reads seek by; frozen 001 declares them beside history's. */
export const JOURNAL_DOMAIN_ITEM_READ_COLUMNS = [
  'kind TEXT',
  'message_role TEXT',
  'turn_id TEXT',
  'opener_item_id TEXT',
  'context_clear INTEGER NOT NULL DEFAULT 0',
  'goal_transition INTEGER NOT NULL DEFAULT 0',
  'producer_agent_id TEXT',
  'producer_parent_ref TEXT',
  'producer_attempt INTEGER'
] as const

export const JOURNAL_DOMAIN_ITEM_READ_INDEXES = `
CREATE INDEX journal_items_kind ON journal_items(session_id, epoch, kind, ordinal) WHERE hidden=0;
CREATE INDEX journal_items_user_message ON journal_items(session_id, epoch, ordinal)
  WHERE hidden=0 AND kind='message' AND message_role='user';
CREATE INDEX journal_items_named_turn ON journal_items(session_id, epoch, turn_id, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_id IS NOT NULL;
CREATE INDEX journal_items_opener ON journal_items(session_id, epoch, opener_item_id, ordinal)
  WHERE hidden=0 AND opener_item_id IS NOT NULL;
CREATE INDEX journal_items_context_clear ON journal_items(session_id, epoch, sequence)
  WHERE hidden=0 AND context_clear=1;
CREATE INDEX journal_items_goal_transition ON journal_items(session_id, epoch, sequence, ordinal)
  WHERE hidden=0 AND goal_transition=1;
CREATE INDEX journal_items_producer_parent ON journal_items(session_id, epoch, producer_parent_ref, ordinal, producer_agent_id)
  WHERE hidden=0 AND producer_parent_ref IS NOT NULL;
CREATE INDEX journal_items_producer_attempt ON journal_items(session_id, epoch, producer_agent_id, producer_attempt)
  WHERE hidden=0 AND producer_agent_id IS NOT NULL;
CREATE INDEX journal_submission_order ON journal_submission_attempts(session_id, epoch, submitted_at, ordinal, message_id)
  WHERE current=1;
CREATE INDEX journal_item_tombstones_turn ON journal_item_tombstones(session_id, epoch, turn_id)
  WHERE turn_id IS NOT NULL;
`

/** The removed item's turn ID, written by the tombstone writer from the row it deletes. */
export const JOURNAL_DOMAIN_TOMBSTONE_READ_COLUMNS = ['turn_id TEXT'] as const

/** Bound in JOURNAL_DOMAIN_ITEM_READ_COLUMNS order by the one item/import upsert. */
export type JournalDomainItemReadColumns = readonly [
  kind: string,
  messageRole: string | null,
  turnId: string | null,
  openerItemId: string | null,
  contextClear: number,
  goalTransition: number,
  producerAgentId: string | null,
  producerParentRef: string | null,
  producerAttempt: number | null
]

/** Row-local facts only, written from each stored revision; no cross-row verdict. */
export function journalDomainItemReadColumns(
  item: AgentJournalRenderItem
): JournalDomainItemReadColumns {
  const { body } = item
  const turn = readAgentJournalTurn(body)
  const producer = claudeAgentRowFacts(item)
  return [
    body.kind,
    body.kind === 'message' ? body.role : null,
    turn?.turnId ?? null,
    body.kind === 'turn' ? (body.userItemId ?? null) : null,
    Number(isAgentSessionContextClear(body)),
    Number(currentAgentSessionThreadGoalSourceBySequence([item]) !== undefined),
    producer?.agentId ?? null,
    producer?.parentRef ?? null,
    producer?.attempt ?? null
  ]
}
