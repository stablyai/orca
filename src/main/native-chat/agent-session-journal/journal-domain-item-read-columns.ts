import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/agent-session/structured-agent-session-command-entry'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { currentAgentSessionThreadGoalSourceBySequence } from '../../../shared/agent-session/agent-session-thread-goal'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { claudeAgentRowFacts } from '../../claude/subagents/claude-subagent-journaled-identities'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { journalDomainOutlineSource } from './journal-domain-outline-source'
import {
  journalItemLifecycleState,
  journalItemStatusMetadata
} from './journal-item-status-metadata'
import { lostLiveWorkJournalBody } from './item-lifecycle/journal-subagent-liveness'
import { isUnverifiedEndAgentJournalToolCall } from '../../../shared/agent-journal-tool-call-lifecycle'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { spelledProviderTimelineItemKey } from '../../../shared/provider-timeline-item-key'

export function journalDomainItemLifecycleColumns(
  item: AgentJournalRenderItem
): readonly [
  lifecycleState: string | null,
  liveWork: number,
  contextWindow: number,
  unverifiedEnd: number,
  turnCompletedAt: number | null
] {
  const { body } = item
  const turn = readAgentJournalTurn(body)
  return [
    (body.kind === 'message' ? body.state : journalItemLifecycleState(body)) ?? null,
    Number(lostLiveWorkJournalBody(body) !== null),
    Number(turn?.contextUsage?.window !== undefined),
    Number(body.kind === 'tool-call' && isUnverifiedEndAgentJournalToolCall(body)),
    typeof turn?.completedAt === 'number' ? turn.completedAt : null
  ]
}

/** Bound in item-read column order by the one item/import upsert. */
export type JournalDomainItemReadColumns = readonly [
  kind: string,
  messageRole: string | null,
  turnId: string | null,
  openerItemId: string | null,
  contextClear: number,
  goalTransition: number,
  producerAgentId: string | null,
  producerParentRef: string | null,
  producerAttempt: number | null,
  prompt: number,
  signedOut: number
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
    turn?.userItemId ?? null,
    Number(isAgentSessionContextClear(body)),
    Number(currentAgentSessionThreadGoalSourceBySequence([item]) !== undefined),
    producer?.agentId ?? null,
    producer?.parentRef ?? null,
    producer?.attempt ?? null,
    Number(
      body.kind === 'message' &&
        body.role === 'user' &&
        isRootAgentJournalItem(item) &&
        !isStructuredAgentSessionCommandEntry(body)
    ),
    Number(
      body.kind === 'status' &&
        readWholeAgentSessionFailureFact(body.failure)?.kind === 'notSignedIn'
    )
  ]
}

export const JOURNAL_DOMAIN_ITEM_COLUMNS = [
  'root',
  'subagent_row',
  'subagent_group_key',
  'turn_marker',
  'wire_version',
  'wire_bytes',
  'wire_json',
  'detail_json',
  'outline_source_json',
  'turn_item_id',
  'kind',
  'message_role',
  'turn_id',
  'opener_item_id',
  'context_clear',
  'goal_transition',
  'producer_agent_id',
  'producer_parent_ref',
  'producer_attempt',
  'prompt',
  'signed_out',
  'lifecycle_state',
  'live_work',
  'context_window',
  'unverified_end',
  'turn_completed_at',
  'command_entry',
  'assistant_prose',
  'turn_scope_kind',
  'provider_turn_id',
  'codex_thread_id',
  'codex_turn_id',
  'legacy_provider_item_key'
] as const

/** Source facts and explicit presentation supply import and current writes. */
export function journalDomainItemColumns(
  item: AgentJournalRenderItem,
  payload: string,
  displayed = item
) {
  const metadata = journalDomainHistoryMetadata(item, payload, displayed)
  const [, commandEntry, , assistantProse, turnScopeKind] = journalItemStatusMetadata(item)
  const turn = readAgentJournalTurn(item.body)
  const identity = parseAgentJournalItemKey(item.itemId)
  return {
    metadata,
    values: [
      metadata.root,
      metadata.subagentRow,
      metadata.subagentGroupKey,
      metadata.turnMarker,
      metadata.wireVersion,
      metadata.wireBytes,
      metadata.wireJson,
      metadata.detailJson,
      journalDomainOutlineSource(displayed),
      item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null,
      ...journalDomainItemReadColumns(item),
      ...journalDomainItemLifecycleColumns(item),
      commandEntry,
      assistantProse,
      turnScopeKind,
      turn?.providerTurnId ?? turn?.turnId ?? null,
      identity?.provider === 'codex' ? identity.threadId : null,
      identity?.provider === 'codex' ? identity.turnId : null,
      identity?.provider === 'legacy' ? spelledProviderTimelineItemKey(identity.recordId) : null
    ]
  }
}
