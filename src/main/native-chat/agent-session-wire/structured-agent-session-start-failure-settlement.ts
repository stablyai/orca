// The writer of a failed start's record: the message it failed, rejected, and its row keyed by that
// message, in one write, so a client that hides rejected messages still sees why. The delivery loop
// writes it for the queued message a start was for, the handover for the message it was handing
// over; the exit writes one row for the handed messages it rejected, keyed by the oldest, whose
// words it carries, or one keyed by the start for a start no message carries. Each message state
// has one writer, and `rejected` is terminal, so no message is failed twice. A start failing as
// its run's row already says writes no row; its message is read under that one.

import type {
  AgentJournalDispatchRejection,
  AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isFailedStartOrHostFault } from '../../../shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../shared/structured-agent-session-start-failure-row-key'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { structuredAgentSessionMessageCommand } from './structured-agent-session-command-turn'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'

type StartFailureJournal = Pick<
  AgentSessionJournal,
  'submissions' | 'itemBody' | 'appendLifecycleBatch'
>

/** A failed start's row in the chat: an error row keyed by its message (or by the start, for one no
 *  message carries), repeating the message's sentence, so the reason outlives any client that hides
 *  it. */
export function structuredAgentSessionStartFailureRow(
  startKey: string,
  words: AgentJournalDispatchRejection
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: structuredAgentSessionStartFailureRowIdentity(startKey),
    body: { kind: 'status', text: words.reason, tone: 'error', failure: words.rejection },
    // A start that failed opened no turn.
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

/** Rejects a message its start failed and writes that start's row with it, keyed by the message, in
 *  one append; the journal's lane drops the row when its run's row already states it. Writes
 *  nothing once `which` no longer holds for it: Stop withdrew it, or another writer settled it. */
export async function rejectWithStartFailureRow(
  journal: Pick<AgentSessionJournal, 'appendLifecycleBatch'>,
  input: {
    clientMessageId: string
    words: AgentJournalDispatchRejection
    fence: number
    which: (submission: AgentJournalSubmission) => boolean
  }
): Promise<void> {
  const { clientMessageId, words, fence, which } = input
  await journal.appendLifecycleBatch({
    settlementId: `start-failure:${clientMessageId}`,
    fence,
    recovered: true,
    mutations: [structuredAgentSessionStartFailureRow(clientMessageId, words)],
    rejects: { clientMessageId, ...words, which }
  })
}

/** Who the message's sentence names, and the command its own body sends. */
function startFailureWordsContext(
  journal: Pick<AgentSessionJournal, 'itemBody'>,
  record: AgentSessionRecord | null,
  clientMessageId: string
): AgentSessionFailureWordsContext {
  const command = structuredAgentSessionMessageCommand(journal, clientMessageId)
  return {
    ...structuredAgentSessionFailureWordsContext(record),
    ...(command ? { command } : {})
  }
}

/** Whether the message is still accepted and not yet handed over. */
export function isStillQueued(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  clientMessageId: string
): boolean {
  const submission = journal
    .submissions()
    .find((entry) => entry.clientMessageId === clientMessageId)
  return submission !== undefined && isQueuedAgentJournalSubmission(submission)
}

/** The delivery loop's record of the queued message a failed start was for. */
export function rejectStructuredAgentSessionStartFailure(
  writer: { journal: StartFailureJournal; fence: number; record: AgentSessionRecord | null },
  cause: StructuredAgentSessionStartFailureCause,
  clientMessageId: string
): Promise<void> {
  return rejectWithStartFailureRow(writer.journal, {
    clientMessageId,
    words: structuredAgentSessionStartFailure(
      cause,
      startFailureWordsContext(writer.journal, writer.record, clientMessageId)
    ),
    fence: writer.fence,
    which: isQueuedAgentJournalSubmission
  })
}

type FailedStartSubmission = Pick<AgentJournalSubmission, 'dispatchState'> &
  Partial<Pick<AgentJournalSubmission, 'fence' | 'reason' | 'rejection'>>

type ExitSubmission = FailedStartSubmission &
  Pick<AgentJournalSubmission, 'clientMessageId' | 'handoverRecorded' | 'handedOverAt'>

/** Whether a message was rejected as the failed start of the child under `fence`. */
export function rejectedAsFailedStartAt(submission: FailedStartSubmission, fence: number): boolean {
  return (
    submission.dispatchState === 'rejected' &&
    submission.fence === fence &&
    isFailedStartOrHostFault({ reason: submission.reason ?? null, rejection: submission.rejection })
  )
}

/** The row an exit during startup writes for its start. The messages it rejected take this row,
 *  keyed by the one its words are for, so a row worded for a command is that command's. With none,
 *  a message still waiting on the start is the delivery loop's to record with its own row, and one
 *  already rejected as this start's failure has its writer's; anything else — a command, goal or
 *  rewind start, or one no message is charged with — has only this row, keyed by the start, to say
 *  why. The journal's lane drops it when its run's row already says it. */
export function exitStartFailureRow(
  journal: { submissions?: () => ExitSubmission[] },
  exit: {
    startKey: string
    /** The message the words are for, if any. */
    wordedFor: string | undefined
    /** The message the start was for, if any. */
    startedFor: string | undefined
    fence: number
    rejected: readonly string[]
    words: AgentJournalDispatchRejection
  }
): JournalLifecycleMutationInput[] {
  if (exit.rejected.length > 0) {
    const key =
      exit.wordedFor !== undefined && exit.rejected.includes(exit.wordedFor)
        ? exit.wordedFor
        : exit.startKey
    return [structuredAgentSessionStartFailureRow(key, exit.words)]
  }
  const recordedElsewhere = (journal.submissions?.() ?? []).some(
    (submission) =>
      (submission.clientMessageId === exit.startedFor &&
        isQueuedAgentJournalSubmission(submission)) ||
      rejectedAsFailedStartAt(submission, exit.fence)
  )
  return recordedElsewhere ? [] : [structuredAgentSessionStartFailureRow(exit.startKey, exit.words)]
}

export function oldestQueuedSubmission(
  session: Pick<StructuredAgentSessionHostSession, 'journal'>
): ReturnType<StructuredAgentSessionHostSession['journal']['submissions']>[number] | undefined {
  let oldest: ReturnType<typeof oldestQueuedSubmission>
  for (const submission of session.journal.submissions()) {
    if (
      isQueuedAgentJournalSubmission(submission) &&
      (oldest === undefined || (submission.acceptedSequence ?? 0) < (oldest.acceptedSequence ?? 0))
    ) {
      oldest = submission
    }
  }
  return oldest
}
