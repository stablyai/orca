import { vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { plannedBatchThrough } from './structured-agent-session-settlement-double.test-fixture'
import { turnVerdictFromDeathEvidence } from './structured-agent-session-stale-turn-verdict'

export const THREAD = 'thread-1'

export const RUNNING_IDENTITY = {
  provider: 'codex' as const,
  threadId: THREAD,
  turnId: 'turn-2',
  ordinal: 0
}

export function turnScopeOf(identity: AgentJournalItemIdentity): AgentJournalTurnScope {
  return { kind: 'turn', turnItemId: agentJournalItemKey(identity) }
}

export function lifecycleItem(
  turnId: string,
  state: 'running' | 'completed',
  sequence: number,
  extra: { startedAt?: number; completedAt?: number } = {}
): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({ provider: 'codex', threadId: THREAD, turnId, ordinal: 0 }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', turnId, state, ...extra }
  }
}

/** Read legacy status-form lifecycle carriers without writing them back. */

export function legacyLifecycleItem(turnId: string, startedAt: number): AgentJournalRenderItem {
  return {
    ...lifecycleItem(turnId, 'running', 2),
    body: {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId, state: 'running', startedAt }
    }
  }
}

export function promptItem(
  state: 'pending' | 'resolved',
  sequence: number
): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: `approval-${state}`
    }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [],
      resolution: {
        state,
        selectedOptionId: state === 'resolved' ? 'allow' : null,
        resolvedBy: state === 'resolved' ? 'client-1' : null,
        resolvedAt: state === 'resolved' ? 10 : null
      }
    }
  }
}

export const verdictForTurn = (evidence: AgentSessionDeathEvidence | null | undefined) =>
  turnVerdictFromDeathEvidence(evidence && { ownerFence: 1, ...evidence }, 1)

export const PROVEN: AgentSessionDeathEvidence = {
  kind: 'pid-absent',
  detail: 'recorded pid absent on host',
  observedAt: 9_000,
  ownerFence: 1,
  lastProvenAliveAt: 100
}

export function journalWith(items: AgentJournalRenderItem[]) {
  const appendLifecycleBatch = vi.fn(async () => ({ epoch: 'epoch-1', sequence: 9 }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the settle reads only these journal members.
  const journal = {
    snapshot: () => ({ items }),
    itemFence: () => 1,
    lastProviderActivityAt: () => undefined,
    stopMarks: { latest: () => null },
    cursor: () => ({ epoch: 'epoch-1', sequence: 8 }),
    submissions: () => [],
    appendPlannedLifecycleBatch: plannedBatchThrough(appendLifecycleBatch)
  } as unknown as AgentSessionJournal
  return { journal, appendLifecycleBatch }
}
