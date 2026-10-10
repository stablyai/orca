import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { journalPendingSubmissionResolutions } from '../agent-session-journal/journal-pending-submission-recovery'
import {
  journalLifecycleMutationItemId,
  type JournalLifecycleMutationInput
} from '../agent-session-journal/journal-row-builders'
import {
  endedUnseenMessageBody,
  runningCallEnd,
  terminalAgentJournalBody
} from '../agent-session-journal/journal-terminal-settlement'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import {
  hasStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRow
} from './structured-agent-session-start-failure-row'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import {
  endedByPersonsStop,
  provenUnverifiableTurnRevisions,
  provenUnverifiedToolCallRevisions,
  runningTurnLifecycleRevisions,
  lastProvenTurnLiveAt,
  turnVerdictFromDeathEvidence,
  turnVerdictFromReplacedRuntime,
  watchedExitRevisions,
  type StructuredAgentSessionTurnVerdict,
  type StructuredAgentSessionWatchedExit
} from './structured-agent-session-stale-turn-verdict'
import {
  exitedRootTurnScope,
  settledRootTurnScope
} from './structured-agent-session-exit-turn-scope'
import {
  hasUnfinishedStructuredAgentSessionWork,
  isInProgressStructuredAgentSessionItem,
  type DeadGenerationJournal
} from './structured-agent-session-unfinished-work'
import { codexUnopenedSendResolutions } from './structured-agent-session-unopened-send-withdrawal'
import type { AgentSessionReplacedRuntime } from '../../runtime/agent-session-replaced-runtime'
import {
  isUnverifiableTurn,
  staleStopRow,
  type StaleCut
} from './structured-agent-session-stale-stop-row'

/** Bounds the exit reason the lease keeps as log evidence; a provider diagnostic is held to the
 *  same cap. */
export const MAX_UNEXPECTED_EXIT_REASON_CHARS = MAX_PROVIDER_DIAGNOSTIC_CHARS

/** Whether the settlement was written, and what stopped it when it was not. */
export type StructuredAgentSessionDeadGenerationSettlement =
  | { ok: true }
  | { ok: false; error: unknown }

export async function settleStructuredAgentSessionDeadGeneration(input: {
  journal: DeadGenerationJournal
  sessionId: string
  fence: number
  settlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  pendingSubmissionReason: string
  showUnexpectedExitOutcome?: boolean
  /** Why the provider stopped, as the adapter told it; the row's sentence is this fact's. */
  exitFailure?: SubmissionRejectionFact
  /** Who a failed start's sentence names. */
  failureTextContext?: AgentSessionFailureWordsContext
  /** The provider never finished starting: the start that failed, keyed by the child's
   *  generation. Its row is the one the delivery loop writes for the same start. */
  exitedDuringStartup?: { generation: string | null }
  /** The exit, watched: what that child's own translator could only end `unverifiable` (its stream
   *  closed before the exit was proven) is revised in this batch. */
  exit?: StructuredAgentSessionWatchedExit
  /** A person's Stop ended a starting child before what it was handed could run: each is rejected so. */
  unrunRejection?: SubmissionRejectionFact
}): Promise<StructuredAgentSessionDeadGenerationSettlement> {
  try {
    const hasUnfinishedWork = hasUnfinishedStructuredAgentSessionWork(input.journal, input.exit)
    const showUnexpectedExitOutcome = input.showUnexpectedExitOutcome ?? hasUnfinishedWork
    if (!showUnexpectedExitOutcome && !hasUnfinishedWork) {
      return { ok: true }
    }
    // A queued message is the delivery loop's to settle: it was never handed to this child. A send
    // a child still starting was handed and never echoed did not run, and its root is gone: it is
    // rejected, with the child's own diagnostic or as the Stop that ended it. A proven child's
    // handed-over sends stay in doubt.
    const startupFailure = input.exitedDuringStartup
      ? structuredAgentSessionStartFailure({ exit: input.exitFailure }, input.failureTextContext)
      : null
    const closed = input.unrunRejection
    const unrun =
      startupFailure ?? (closed && agentSessionFailureWords(closed, { surface: 'rejection' }))
    const withdrawn = unrun ? [] : codexUnopenedSendResolutions(input.journal, input.fence)
    const withdrawnIds = new Set(withdrawn.map((entry) => entry.clientMessageId))
    const dispatches = [
      ...withdrawn,
      ...journalPendingSubmissionResolutions(
        (input.journal.submissions?.() ?? input.journal.pendingSubmissions?.() ?? []).filter(
          (entry) => !withdrawnIds.has(entry.clientMessageId)
        ),
        input.fence,
        unrun ? { rejection: unrun } : { reason: input.pendingSubmissionReason }
      )
    ]
    const items = input.journal.snapshot().items
    const proven = watchedExitRevisions(items, input.exit, input.journal)
    const mutations: JournalLifecycleMutationInput[] = []
    if (showUnexpectedExitOutcome && input.exitedDuringStartup && startupFailure) {
      const startKey = input.exitedDuringStartup.generation ?? input.settlementId
      // A start a message waited on is the delivery loop's to record, before or after this exit,
      // in the words it rejected the message with; this row is for a command, goal or rewind start.
      // A row already written stays: rejected is terminal, so its words are not reworded.
      const recordedByDeliveryLoop =
        input.journal.submissions?.().some(isQueuedAgentJournalSubmission) ||
        hasStructuredAgentSessionStartFailureRow(items, startKey)
      if (!recordedByDeliveryLoop) {
        mutations.push(structuredAgentSessionStartFailureRow(startKey, startupFailure))
      }
    } else if (showUnexpectedExitOutcome) {
      // The turn the exit ended, and an error so no fold ever hides why it stopped.
      mutations.push({
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: input.settlementId },
        body: {
          kind: 'status',
          ...agentSessionFailureWords(
            input.exitFailure ?? agentSessionFailureFact('providerExited'),
            {
              ...input.failureTextContext,
              surface: 'row'
            }
          ),
          tone: 'error'
        },
        turnScope: exitedRootTurnScope(withRevisions(items, proven), input.verdict)
      })
    }
    const bodies = new Map(items.map((item) => [item.itemId, item.body]))
    for (const item of items) {
      // Ended as its turn is: a proven death cuts a running call short. An open reasoning row is
      // ended too, but is not unfinished work: its running turn already says so.
      const end = runningCallEnd(item.turnScope, (id) => bodies.get(id), input.verdict.state)
      const body = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
      if (body) {
        mutations.push({
          kind: 'item',
          itemId: item.itemId,
          body,
          turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
        })
      }
    }
    mutations.push(...runningTurnLifecycleRevisions(items, input.verdict), ...proven)
    await input.journal.appendLifecycleBatch({
      settlementId: `dead-generation:${input.settlementId}`,
      fence: input.fence,
      recovered: true,
      mutations,
      dispatches
    })
    return { ok: true }
  } catch (error) {
    // Returned rather than logged: each caller logs it under its own scope.
    return { ok: false, error }
  }
}

/**
 * Settles whatever a generation with no child in this process left running: found when a new child
 * is acquired, or when a chat is reopened for reading. Derived from the journal, the lease's death
 * evidence and the runtimes this one replaced each time, so nothing is owed in between. Either proof
 * ends the turn interrupted, and a proof written after an earlier settle revises what that settle
 * left `unverifiable`, the turn and the calls it closed alike. Must run before a new child's
 * buffered events land, or a live turn would be judged.
 */
export async function settleStaleStructuredAgentSessionState(input: {
  journal: AgentSessionJournal
  sessionId: string
  fence: number
  acquisitionGeneration: string | null
  deathEvidence: AgentSessionDeathEvidence | null
  /** The runtimes this one replaced for this chat: every owner they held lost its pipes with them. */
  replaced?: AgentSessionReplacedRuntime
  /** Who the exit row names. */
  failureTextContext?: AgentSessionFailureWordsContext
}): Promise<number> {
  const { journal, replaced } = input
  const items = journal.snapshot().items
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
  // A successful settlement leaves terminal items; a failed transaction leaves the same prefix.
  const generation = input.acquisitionGeneration ?? `seq-${journal.cursor().sequence}`
  const settlementId = `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:${input.fence}:${generation}`
  // Calls an earlier settle closed with no proof, revised once a proof names their owner.
  const mutations = provenUnverifiedToolCallRevisions(items, input.deathEvidence, journal, replaced)
  for (const item of items) {
    // A turn already settled (a person's Stop) ends its calls as it ended; only a turn still running
    // leaves them to the evidence.
    const end = runningCallEnd(item.turnScope, (id) => journal.itemBody(id), verdictFor(item).state)
    const body = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
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
  const stopRow = staleStopRow(input, items, (item): StaleCut => {
    const unverifiable = isUnverifiableTurn(item)
    if (!unverifiable && !isInProgressStructuredAgentSessionItem(item)) {
      return null
    }
    const fence = journal.itemFence(item.itemId)
    // An earlier settle's `unverifiable` turn is revised by a death naming its owner or by its replaced runtime.
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
  if (mutations.length > 0) {
    await journal.appendLifecycleBatch({
      settlementId,
      fence: input.fence,
      recovered: true,
      mutations
    })
  }
  return mutations.length
}

function withRevisions(
  items: readonly AgentJournalRenderItem[],
  revisions: readonly JournalLifecycleMutationInput[]
): AgentJournalRenderItem[] {
  const bodies = new Map(
    revisions.flatMap((revision): [string, AgentJournalItemBody][] =>
      revision.kind === 'item' ? [[journalLifecycleMutationItemId(revision), revision.body]] : []
    )
  )
  return items.map((item) => ({ ...item, body: bodies.get(item.itemId) ?? item.body }))
}
