import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { partitionJournalLifecycleMutations } from '../agent-session-journal/journal-lifecycle-batch-partition'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
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
import { exitStartFailureRow } from './structured-agent-session-start-failure-settlement'
import { structuredAgentSessionAwaitedMessage } from './structured-agent-session-command-turn'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import {
  endedByPersonsStop,
  provenUnverifiableTurnRevisions,
  provenUnverifiedToolCallRevisions,
  runningTurnLifecycleRevisions,
  stopFoundTurnLiveAt,
  turnVerdictFromDeathEvidence,
  watchedExitRevisions,
  type StructuredAgentSessionTurnVerdict,
  type StructuredAgentSessionWatchedExit
} from './structured-agent-session-stale-turn-verdict'
import {
  exitedRootTurnScope,
  settledRootTurnScope
} from './structured-agent-session-exit-turn-scope'
import { orcaStopRowBody } from './structured-agent-session-orca-stop-row'
import {
  hasUnfinishedStructuredAgentSessionWork,
  isInProgressStructuredAgentSessionItem,
  type DeadGenerationJournal
} from './structured-agent-session-unfinished-work'
import { withdrawCodexSendsNoTurnOpenedFor } from './structured-agent-session-unopened-send-withdrawal'

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
   *  generation, for the row a start no message carries leaves; `startedFor`, the message it was
   *  started for, which the delivery loop rejects with its own row while it is still queued. */
  exitedDuringStartup?: { generation: string | null; startedFor?: string }
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
    if (!unrun) {
      await withdrawCodexSendsNoTurnOpenedFor(input.journal, input.fence)
    }
    // Read before it is rejected: the message a failed start's words are for.
    const wordedFor = structuredAgentSessionAwaitedMessage(input.journal)
    const settled = await (unrun
      ? input.journal.rejectPendingSubmissions(input.fence, unrun)
      : input.journal.markPendingSubmissionsUnknown(input.fence, input.pendingSubmissionReason))
    const items = input.journal.snapshot().items
    const proven = watchedExitRevisions(items, input.exit, input.journal)
    const mutations: JournalLifecycleMutationInput[] = []
    if (showUnexpectedExitOutcome && input.exitedDuringStartup && startupFailure) {
      mutations.push(
        ...exitStartFailureRow(input.journal, {
          startKey: input.exitedDuringStartup.generation ?? input.settlementId,
          wordedFor,
          fence: input.fence,
          rejected: settled,
          startedFor: input.exitedDuringStartup.startedFor,
          words: startupFailure
        })
      )
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
      const identity = parseAgentJournalItemKey(item.itemId)
      // Ended as its turn is: a proven death cuts a running call short. An open reasoning row is
      // ended too, but is not unfinished work: its running turn already says so.
      const end = runningCallEnd(item.turnScope, (id) => bodies.get(id), input.verdict.state)
      const body = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
      if (identity && body) {
        mutations.push({
          kind: 'item',
          identity,
          body,
          turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
        })
      }
    }
    mutations.push(...runningTurnLifecycleRevisions(items, input.verdict), ...proven)
    const batchId = `dead-generation:${input.settlementId}`
    for (const chunk of partitionJournalLifecycleMutations(batchId, mutations)) {
      await input.journal.appendLifecycleBatch({
        settlementId: chunk.settlementId,
        fence: input.fence,
        recovered: true,
        mutations: chunk.mutations
      })
    }
    return { ok: true }
  } catch (error) {
    // Returned rather than logged: each caller logs it under its own scope.
    return { ok: false, error }
  }
}

/**
 * Settles whatever a generation with no child in this process left running: found when a new child
 * is acquired, or when a chat is reopened for reading. Derived from the journal and the lease's
 * death evidence each time, so nothing is owed in between. Proven death ends the turn interrupted,
 * and a proof written after an earlier settle revises what that settle left `unverifiable`, the
 * turn and the calls it closed alike. Must run before a new child's buffered events land, or a
 * live turn would be judged.
 */
export async function settleStaleStructuredAgentSessionState(input: {
  journal: AgentSessionJournal
  sessionId: string
  fence: number
  acquisitionGeneration: string | null
  deathEvidence: AgentSessionDeathEvidence | null
  /** Who the exit row names. */
  failureTextContext?: AgentSessionFailureWordsContext
}): Promise<number> {
  const { journal } = input
  const items = journal.snapshot().items
  // Each turn is judged by the evidence only if it names that turn's owner.
  const verdictFor = (item: AgentJournalRenderItem) =>
    turnVerdictFromDeathEvidence(
      input.deathEvidence,
      journal.itemFence(item.itemId),
      stopFoundTurnLiveAt(journal, item)
    )
  // Per attempt: a retry re-partitions only what is left, and a reused chunk id would skip it.
  const generation = input.acquisitionGeneration ?? `seq-${journal.cursor().sequence}`
  const settlementId = `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:${input.fence}:${generation}`
  // Calls an earlier settle closed with no proof, revised once a proof names their owner.
  const mutations = provenUnverifiedToolCallRevisions(items, input.deathEvidence, journal)
  for (const item of items) {
    const identity = parseAgentJournalItemKey(item.itemId)
    // A turn already settled (a person's Stop) ends its calls as it ended; only a turn still running
    // leaves them to the evidence.
    const end = runningCallEnd(item.turnScope, (id) => journal.itemBody(id), verdictFor(item).state)
    const body = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
    if (identity && body) {
      mutations.push({
        kind: 'item',
        identity,
        body,
        turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  }
  const proven = provenUnverifiableTurnRevisions(items, input.deathEvidence, journal)
  const turnEnds = [
    ...items.flatMap((item) => runningTurnLifecycleRevisions([item], verdictFor(item))),
    ...proven
  ]
  mutations.push(...turnEnds)
  const evidence = input.deathEvidence
  if (
    evidence &&
    (proven.length > 0 ||
      items.some(
        (item) =>
          isInProgressStructuredAgentSessionItem(item) && verdictFor(item).state === 'interrupted'
      )) &&
    !endedByPersonsStop(journal, turnEnds)
  ) {
    mutations.unshift({
      kind: 'item',
      // Named by the death it explains, so a retry after a partly written settle adds no second row.
      identity: {
        provider: 'orca',
        clientMessageId: `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:death-${evidence.ownerFence ?? 'unowned'}-${evidence.observedAt}`
      },
      // The death evidence is Orca's log text, never a sentence for a person: the row says only
      // that the provider stopped, and how Orca ended when the provider died with it.
      body: orcaStopRowBody(input.failureTextContext, evidence.runtimeEnd),
      turnScope: settledRootTurnScope(items, turnEnds)
    })
  }
  for (const chunk of partitionJournalLifecycleMutations(settlementId, mutations)) {
    await journal.appendLifecycleBatch({
      settlementId: chunk.settlementId,
      fence: input.fence,
      recovered: true,
      mutations: chunk.mutations
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
      revision.kind === 'item' ? [[agentJournalItemKey(revision.identity), revision.body]] : []
    )
  )
  return items.map((item) => ({ ...item, body: bodies.get(item.itemId) ?? item.body }))
}
