// Plan against queued journal state; death/replacement proof interrupts only matching owners,
// otherwise settle unverifiable and revise when later proof arrives.

import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import type { AgentSessionReplacedRuntime } from '../../runtime/agent-session-replaced-runtime'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import { journalPendingSubmissionResolutions } from '../agent-session-journal/journal-pending-submission-recovery'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { ResolveDispatchInput } from '../agent-session-journal/journal-store-contracts'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { lostLiveWorkJournalBody } from '../agent-session-journal/journal-subagent-liveness'
import {
  endedUnseenMessageBody,
  runningCallEnd,
  terminalAgentJournalBody
} from '../agent-session-journal/journal-terminal-settlement'
import {
  endedByPersonsStop,
  provenUnverifiableTurnRevisions,
  provenUnverifiedToolCallRevisions,
  lastProvenTurnLiveAt,
  runningTurnLifecycleRevisions,
  turnVerdictFromDeathEvidence,
  turnVerdictFromReplacedRuntime
} from './structured-agent-session-stale-turn-verdict'
import { settledRootTurnScope } from './structured-agent-session-exit-turn-scope'
import { isUnverifiableTurn, staleStopRow } from './structured-agent-session-stale-stop-row'
import { isInProgressStructuredAgentSessionItem } from './structured-agent-session-unfinished-work'

export type StaleStructuredAgentSessionStateJournal = Pick<
  AgentSessionJournal,
  | 'snapshot'
  | 'itemFence'
  | 'itemBody'
  | 'submissions'
  | 'stopMarks'
  | 'lastProviderActivityAt'
  | 'cursor'
  | 'appendPlannedLifecycleBatch'
>

export type StaleStructuredAgentSessionStateInput = {
  journal: StaleStructuredAgentSessionStateJournal
  sessionId: string
  fence: number
  acquisitionGeneration: string | null
  deathEvidence: AgentSessionDeathEvidence | null
  /** Replaced owners lost their transports with their runtime. */
  replaced?: AgentSessionReplacedRuntime
  failureTextContext?: AgentSessionFailureWordsContext
  /** Settle owners below this fence, including unanswered handoffs; absent settles all items but no sends. */
  below?: number
}

export async function settleStaleStructuredAgentSessionState(
  input: StaleStructuredAgentSessionStateInput
): Promise<number> {
  const { journal } = input
  // Terminal results make retries no-ops; failed transactions retain the same identity prefix.
  const generation = input.acquisitionGeneration ?? `seq-${journal.cursor().sequence}`
  let planned = 0
  await journal.appendPlannedLifecycleBatch({
    settlementId: `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:${input.fence}:${generation}`,
    fence: input.fence,
    recovered: true,
    plan: () => {
      const plan = planStaleStructuredAgentSessionState(input)
      planned = plan.mutations.length
      return plan
    }
  })
  return planned
}

export function planStaleStructuredAgentSessionState(
  input: StaleStructuredAgentSessionStateInput
): {
  mutations: JournalLifecycleMutationInput[]
  dispatches: ResolveDispatchInput[]
} {
  const { journal, below } = input
  const ended = (fence: number | undefined) =>
    below === undefined || (fence !== undefined && fence < below)
  const items = journal.snapshot().items.filter((item) => ended(journal.itemFence(item.itemId)))
  const dispatches =
    below === undefined
      ? []
      : journalPendingSubmissionResolutions(
          journal.submissions().filter((entry) => ended(entry.fence)),
          input.fence,
          // Unanswered handover proves uncertainty, never non-delivery.
          { reason: DISPATCH_DOUBT_PROVIDER_EXITED }
        )
  return { mutations: staleMutations(input, items), dispatches }
}

function staleMutations(
  input: StaleStructuredAgentSessionStateInput,
  items: readonly AgentJournalRenderItem[]
): JournalLifecycleMutationInput[] {
  const { journal, replaced } = input
  const deathVerdictFor = (item: AgentJournalRenderItem) =>
    turnVerdictFromDeathEvidence(
      input.deathEvidence,
      journal.itemFence(item.itemId),
      lastProvenTurnLiveAt(journal, item)
    )
  const replacedVerdictFor = (item: AgentJournalRenderItem) =>
    turnVerdictFromReplacedRuntime(
      replaced,
      journal.itemFence(item.itemId),
      lastProvenTurnLiveAt(journal, item)
    )
  const verdictFor = (item: AgentJournalRenderItem) => {
    const byDeath = deathVerdictFor(item)
    return byDeath.state === 'interrupted' ? byDeath : replacedVerdictFor(item)
  }
  const mutations = provenUnverifiedToolCallRevisions(items, input.deathEvidence, journal, replaced)
  for (const item of items) {
    // Honor existing personal Stop; only running turns need new evidence.
    const end = runningCallEnd(item.turnScope, (id) => journal.itemBody(id), verdictFor(item).state)
    const terminal = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
    const body = lostLiveWorkJournalBody(terminal ?? item.body) ?? terminal
    if (body) {
      mutations.push({
        kind: 'item',
        itemId: item.itemId,
        body,
        turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  }
  const proven = provenUnverifiableTurnRevisions(items, input.deathEvidence, journal, replaced)
  const turnEnds = [
    ...items.flatMap((item) => runningTurnLifecycleRevisions([item], verdictFor(item))),
    ...proven
  ]
  mutations.push(...turnEnds)
  const stopRow = staleStopRow(input, items, (item) => {
    const unverifiable = isUnverifiableTurn(item)
    if (!unverifiable && !isInProgressStructuredAgentSessionItem(item)) {
      return null
    }
    const fence = journal.itemFence(item.itemId)
    if (
      unverifiable
        ? fence !== undefined && fence === input.deathEvidence?.ownerFence
        : deathVerdictFor(item).state === 'interrupted'
    ) {
      return { by: 'death' }
    }
    return fence !== undefined && replacedVerdictFor(item).state === 'interrupted'
      ? { by: 'replaced', fence }
      : null
  })
  if (stopRow && !endedByPersonsStop(journal, turnEnds)) {
    mutations.unshift({ ...stopRow, turnScope: settledRootTurnScope(items, turnEnds) })
  }
  return mutations
}
