// Everything a non-acquisition open writes because an earlier host process is gone, as one plan.
//
// Built from the per-entity rules in journal-open-settlement-plan.ts, which each chat's stored
// status counts with too, so startup selects a chat when this plan has work beyond revising an
// earlier verdict. The open appends exactly this plan, and each entry revises its entity out of
// the state that selected it.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { partitionJournalLifecycleMutations } from '../agent-session-journal/journal-lifecycle-batch-partition'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  isRunningJournalTurn,
  openSettlementItemIdentity,
  openSettlementTerminalBody,
  owesRecoveredDispatch
} from '../agent-session-journal/journal-open-settlement-plan'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  staleSubagentRosterRevisions,
  type JournalSubagentLivenessRevision
} from '../agent-session-journal/journal-subagent-liveness'
import { runningRootTurnScope } from './structured-agent-session-exit-turn-scope'
import {
  endedByPersonsStop,
  provenUnverifiableTurnRevisions,
  runningTurnLifecycleRevisions,
  stopFoundTurnLiveAt,
  turnVerdictFromDeathEvidence
} from './structured-agent-session-stale-turn-verdict'

/** What the record says about the gone process, or null for the journal-only reading. */
export type OpenSettlementRecordFacts = {
  sessionId: string
  fence: number
  deathEvidence: AgentSessionDeathEvidence | null
  /** Who the exit row names. */
  failureTextContext?: AgentSessionFailureWordsContext
}

export type GoneGenerationSettlement = {
  settlementId: string
  mutations: JournalLifecycleMutationInput[]
}

export type OpenSettlementPlan = {
  /** Handed-over sends nothing answered: each becomes a recovered `unknown`. */
  recoveredDispatches: string[]
  /** Sends accepted and never handed over: each is rejected as the host having restarted. */
  leftoverQueued: string[]
  /** What the gone generation left running. Null on an acquisition's own open, which settles it
   *  against the generation it acquires. */
  goneGeneration: GoneGenerationSettlement | null
  /** Rosters and background tasks still claiming a live child. */
  rosters: JournalSubagentLivenessRevision[]
}

export type OpenSettlementJournal = Pick<
  AgentSessionJournal,
  'snapshot' | 'submissions' | 'itemFence' | 'cursor' | 'stopMarks'
>

export type OpenSettlementOptions = {
  acquisition?: boolean
  /** False on a corrupt load, which still owes a rebuild that a roster write would retire. */
  settlesRosters: boolean
}

export function planOpenSettlement(
  journal: OpenSettlementJournal,
  record: OpenSettlementRecordFacts | null,
  options: OpenSettlementOptions
): OpenSettlementPlan {
  const { items } = journal.snapshot()
  const submissions = journal.submissions()
  return {
    recoveredDispatches: submissions
      .filter(owesRecoveredDispatch)
      .map((submission) => submission.clientMessageId),
    leftoverQueued: submissions
      .filter(isQueuedAgentJournalSubmission)
      .map((submission) => submission.clientMessageId),
    goneGeneration: options.acquisition
      ? null
      : planGoneGenerationSettlement({
          items,
          journal,
          sessionId: record?.sessionId ?? '',
          fence: record?.fence ?? 0,
          // Per attempt: a retry re-partitions only what is left, and a reused chunk id would skip it.
          generation: `seq-${journal.cursor().sequence}`,
          deathEvidence: record?.deathEvidence ?? null,
          failureTextContext: record?.failureTextContext
        }),
    rosters: options.settlesRosters ? staleSubagentRosterRevisions(items) : []
  }
}

/**
 * Settles whatever a generation with no child in this process left running: found when a new child
 * is acquired, or when a chat is reopened. Derived from the journal and the lease's death evidence
 * each time, so nothing is owed in between. Proven death ends the turn interrupted, and a proof
 * written after an earlier settle revises what that settle left `unverifiable`.
 */
export function planGoneGenerationSettlement(input: {
  items: readonly AgentJournalRenderItem[]
  /** Who wrote each item, and what the latest Stop event says about the turn it found. */
  journal: Pick<AgentSessionJournal, 'itemFence' | 'stopMarks'>
  sessionId: string
  fence: number
  generation: string
  deathEvidence: AgentSessionDeathEvidence | null
  failureTextContext?: AgentSessionFailureWordsContext
}): GoneGenerationSettlement {
  const { items } = input
  // Each turn is judged by the evidence only if it names that turn's owner.
  const verdictFor = (item: AgentJournalRenderItem) =>
    turnVerdictFromDeathEvidence(
      input.deathEvidence,
      input.journal.itemFence(item.itemId),
      stopFoundTurnLiveAt(input.journal, item)
    )
  const mutations: JournalLifecycleMutationInput[] = []
  for (const item of items) {
    const identity = openSettlementItemIdentity(item)
    const body = openSettlementTerminalBody(item)
    if (identity && body) {
      mutations.push({
        kind: 'item',
        identity,
        body,
        turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  }
  const proven = provenUnverifiableTurnRevisions(items, input.deathEvidence, input.journal)
  const turnEnds = [
    ...items.flatMap((item) => runningTurnLifecycleRevisions([item], verdictFor(item))),
    ...proven
  ]
  mutations.push(...turnEnds)
  const evidence = input.deathEvidence
  // A turn a person's Stop ended reads as theirs, with no row saying the provider stopped.
  if (
    evidence &&
    (proven.length > 0 ||
      items.some((item) => isInProgressItem(item) && verdictFor(item).state === 'interrupted')) &&
    !endedByPersonsStop(input.journal, turnEnds)
  ) {
    mutations.unshift({
      kind: 'item',
      // Named by the death it explains, so a retry after a partly written settle adds no second row.
      identity: {
        provider: 'orca',
        clientMessageId: `stale-session:${input.sessionId}:death-${evidence.ownerFence ?? 'unowned'}-${evidence.observedAt}`
      },
      // The death evidence is Orca's log text, never a sentence for a person: the row says only
      // that the provider stopped.
      body: {
        kind: 'status',
        ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
          ...input.failureTextContext,
          surface: 'row'
        }),
        tone: 'error'
      },
      turnScope: runningRootTurnScope(items)
    })
  }
  return {
    settlementId: `stale-session:${input.sessionId}:${input.fence}:${input.generation}`,
    mutations
  }
}

/** Appends a gone generation's settlement, in bounded chunks each retry-safe by its id. */
export async function appendGoneGenerationSettlement(
  journal: Pick<AgentSessionJournal, 'appendLifecycleBatch'>,
  settlement: GoneGenerationSettlement,
  fence: number
): Promise<void> {
  for (const chunk of partitionJournalLifecycleMutations(
    settlement.settlementId,
    settlement.mutations
  )) {
    await journal.appendLifecycleBatch({
      settlementId: chunk.settlementId,
      fence,
      recovered: true,
      mutations: chunk.mutations
    })
  }
}

/** The open's writes: exactly the plan, in today's row shapes. Each part is best effort on its own:
 *  what fails stays owed, and the chat's next open or the next startup plans it again. */
export async function appendOpenSettlement(
  journal: AgentSessionJournal,
  plan: OpenSettlementPlan,
  fence: number,
  onError: (error: unknown) => void
): Promise<void> {
  try {
    for (const roster of plan.rosters) {
      // The conversation's row, revised by whichever writer is newest.
      await journal.appendItem(roster.identity, roster.body, {
        fence: journal.highestFence(),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  } catch (error) {
    onError(error)
  }
  try {
    // A handed-over row is only doubt, which provider history decides under a won lease.
    if (plan.recoveredDispatches.length > 0) {
      await journal.markPendingSubmissionsUnknown(fence)
    }
    // A conversation's close abandons what it queued first, so a queued row found here was
    // accepted by a process that is gone.
    if (plan.leftoverQueued.length > 0) {
      const leftovers = new Set(plan.leftoverQueued)
      await journal.rejectQueuedSubmissions(
        fence,
        agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
          surface: 'rejection'
        }),
        (submission) => leftovers.has(submission.clientMessageId)
      )
    }
  } catch (error) {
    onError(error)
  }
  if (plan.goneGeneration && plan.goneGeneration.mutations.length > 0) {
    try {
      await appendGoneGenerationSettlement(journal, plan.goneGeneration, fence)
    } catch (error) {
      // Best effort: the next open or acquire re-derives it.
      onError(error)
    }
  }
}

/** Work that means the provider was MID-RESPONSE, and that this settle revises. A pending approval
 *  or question is the provider waiting on the user, so dying while one sits there interrupted
 *  nothing. */
function isInProgressItem(item: AgentJournalRenderItem): boolean {
  return (
    (isRunningJournalTurn(item) ||
      (item.body.kind === 'tool-call' && item.body.state === 'running')) &&
    openSettlementItemIdentity(item) !== null
  )
}
