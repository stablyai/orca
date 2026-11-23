// A shown prompt's standing from authoritative journal and generation evidence: an empty actionable
// list or an owner Orca can't verify right now is never proof that it ended.
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type {
  StructuredAgentSessionWorkEvidence,
  StructuredAgentSessionReplacedEnd,
  StructuredAgentSessionSeenEnd
} from './structured-agent-session-work-evidence'

/** Still waiting, provably over, or not knowable right now. */
export type StructuredAgentSessionPromptStanding = 'pending' | 'gone' | 'unknown'

export type PromptStandingRead = {
  cursor: AgentJournalCursor
  items: Record<string, StructuredAgentSessionPromptStanding>
}

export type PromptStandingJournal = {
  item(id: string): AgentJournalRenderItem | null
  itemFence(id: string): number | undefined
  hasRecordedItem?(id: string): boolean
}

export type PromptStandingEvidence = {
  readonly liveFence: number | null
  readonly ownerUnverifiable: boolean
  readonly ended?: StructuredAgentSessionSeenEnd | undefined
  readonly replaced?: StructuredAgentSessionReplacedEnd | undefined
  /** A released claim ended every generation through this fence; null while the claim stands. */
  readonly releasedThroughFence: number | null
}

export function structuredAgentSessionPromptStanding(
  journal: PromptStandingJournal,
  itemId: string,
  evidence: PromptStandingEvidence
): StructuredAgentSessionPromptStanding {
  const item = journal.item(itemId)
  if (!item) {
    return journal.hasRecordedItem?.(itemId) === true ? 'gone' : 'unknown'
  }
  const { body } = item
  if (
    (body.kind !== 'approval' && body.kind !== 'question') ||
    body.resolution.state !== 'pending'
  ) {
    return 'gone'
  }
  const turnItemId = item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null
  const turn = turnItemId ? readAgentJournalTurn(journal.item(turnItemId)?.body) : null
  if (turn?.state === 'completed' || turn?.state === 'interrupted') {
    return 'gone'
  }
  // End evidence for the prompt's own generation wins over any uncertainty below.
  const fence = journal.itemFence(itemId)
  if (fence !== undefined && generationProvenEnded(evidence, fence)) {
    return 'gone'
  }
  if (evidence.ownerUnverifiable) {
    return 'unknown'
  }
  const { liveFence } = evidence
  if (liveFence === null || (fence !== undefined && fence < liveFence)) {
    return 'gone'
  }
  return turn?.state === 'running' ? 'pending' : 'unknown'
}

function generationProvenEnded(evidence: PromptStandingEvidence, fence: number): boolean {
  const { ended, replaced, releasedThroughFence } = evidence
  return (
    (ended?.rootGone === true && ended.fence === fence) ||
    (replaced !== undefined && fence <= replaced.fence) ||
    (releasedThroughFence !== null && fence <= releasedThroughFence)
  )
}

/** Through which fence a released claim ended every generation; null while the claim stands. */
export function releasedThroughFence(
  evidence: Pick<StructuredAgentSessionWorkEvidence, 'record'>
): number | null {
  return evidence.record?.ownerObservation?.claimStatus === 'released'
    ? (evidence.record.currentFence ?? 0)
    : null
}
