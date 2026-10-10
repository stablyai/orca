// What a generation that can no longer write left unfinished, settled from the journal, the
// lease's death evidence and the runtimes this one replaced each time it is asked. Either proof ends
// a turn interrupted; anything else is `unverifiable`, until a proof naming its owner revises it. Working subagents and background
// tasks become `unverifiable`. Planned at the batch's own turn in the write queue, so an answer or
// a Stop queued ahead of it is what it settles from.

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
import { journalEntryOwnerFence } from '../agent-session-journal/journal-item-provenance'
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

/** What the settlement reads and writes of a chat's journal. */
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
  /** The fence the settlement's rows are written at: the lease's current one. */
  fence: number
  acquisitionGeneration: string | null
  deathEvidence: AgentSessionDeathEvidence | null
  /** The runtimes this one replaced for this chat: every owner they held lost its pipes with them. */
  replaced?: AgentSessionReplacedRuntime
  /** Who the exit row names. */
  failureTextContext?: AgentSessionFailureWordsContext
  /** Only what generations below this fence wrote, which can no longer write, is settled; their
   *  sends handed over and never answered become doubt. Absent: every item, and no send. */
  below?: number
  /** Roster entries and background tasks are settled by their own provenance
   *  (`journal-item-provenance.ts`): below this fence, in any row, even a live generation's.
   *  Absent: every entry of a row settled here, and no other row's. */
  entriesBelow?: number
}

/** Settles it, and answers how many items it revised. */
export async function settleStaleStructuredAgentSessionState(
  input: StaleStructuredAgentSessionStateInput
): Promise<number> {
  const { journal } = input
  // A successful settlement leaves terminal items; a failed transaction leaves the same prefix.
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

/** The settlement's rows, read from the journal as it stands. */
export function planStaleStructuredAgentSessionState(
  input: StaleStructuredAgentSessionStateInput
): {
  mutations: JournalLifecycleMutationInput[]
  dispatches: ResolveDispatchInput[]
} {
  const { journal, below } = input
  const ended = (fence: number | undefined) =>
    below === undefined || (fence !== undefined && fence < below)
  const all = journal.snapshot().items
  const items = all.filter((item) => ended(journal.itemFence(item.itemId)))
  const dispatches =
    below === undefined
      ? []
      : journalPendingSubmissionResolutions(
          journal.submissions().filter((entry) => ended(entry.fence)),
          input.fence,
          // Doubt, never non-delivery: what a gone owner was handed and never answered.
          { reason: DISPATCH_DOUBT_PROVIDER_EXITED }
        )
  const mutations = staleMutations(input, items)
  const { entriesBelow } = input
  if (entriesBelow !== undefined) {
    // A live generation's row can still carry a child or a task an ended one ran.
    for (const item of all) {
      const itemFence = journal.itemFence(item.itemId)
      const body = ended(itemFence)
        ? null
        : lostLiveWorkJournalBody(item.body, (entry) =>
            entryEndedBelow(entry, itemFence, entriesBelow)
          )
      if (body) {
        mutations.push({
          kind: 'item',
          itemId: item.itemId,
          body,
          turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
        })
      }
    }
  }
  return { mutations, dispatches }
}

function entryEndedBelow(
  entry: { ownerFence?: number },
  itemFence: number | undefined,
  below: number
): boolean {
  const fence = journalEntryOwnerFence(entry, itemFence)
  return fence !== undefined && fence < below
}

function staleMutations(
  input: StaleStructuredAgentSessionStateInput,
  items: readonly AgentJournalRenderItem[]
): JournalLifecycleMutationInput[] {
  const { journal, replaced } = input
  // Each turn is judged by the evidence only if it names that turn's owner.
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
  // Calls an earlier settle closed with no proof, revised once a proof names their owner.
  const mutations = provenUnverifiedToolCallRevisions(items, input.deathEvidence, journal, replaced)
  for (const item of items) {
    // A turn already settled (a person's Stop) ends its calls as it ended; only a turn still running
    // leaves them to the evidence.
    const end = runningCallEnd(item.turnScope, (id) => journal.itemBody(id), verdictFor(item).state)
    const terminal = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
    // One revision per item: its live subagents and background tasks end with it, but for any a
    // live generation observed since.
    const itemFence = journal.itemFence(item.itemId)
    const { entriesBelow } = input
    const body =
      lostLiveWorkJournalBody(terminal ?? item.body, (entry) =>
        entriesBelow === undefined ? true : entryEndedBelow(entry, itemFence, entriesBelow)
      ) ?? terminal
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
    // An earlier settle's `unverifiable` turn is revised by a death naming its owner or by its
    // replaced runtime.
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
