import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/agent-session/structured-agent-session-command-entry'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { currentAgentSessionThreadGoalSourceBySequence } from '../../../shared/agent-session/agent-session-thread-goal'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { claudeAgentRowFacts } from '../../claude/claude-subagent-journaled-identities'
import { journalItemLifecycleState } from './journal-item-status-metadata'
import { lostLiveWorkJournalBody } from './item-lifecycle/journal-subagent-liveness'

export function journalDomainItemLifecycleColumns(
  item: AgentJournalRenderItem
): readonly [lifecycleState: string | null, liveWork: number] {
  return [journalItemLifecycleState(item.body), Number(lostLiveWorkJournalBody(item.body) !== null)]
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
    body.kind === 'turn' ? (body.userItemId ?? null) : null,
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
