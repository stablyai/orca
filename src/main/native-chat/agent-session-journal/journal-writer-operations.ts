import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import type { AgentSessionQueuedMessageMoveAnchor } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { JournalRow, JournalStopEvent } from './journal-row-schema'
import { composeJournalOperationReceipts, type JournalOperationReceipt } from './journal-row-writer'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  JournalItemAppendOptions,
  JournalSubmissionConsume,
  JournalSubmissionInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type { JournalWriterOperation } from './journal-writer-command'
import type { JournalWriterSession } from './journal-writer-session'
import { planJournalWriterRows } from './journal-writer-plan'
import {
  journalQueueReopenRowBuilder,
  journalQueueResumeRowBuilder,
  journalStopEventRowBuilder
} from './journal-stop-and-resume-rows'
import { journalTombstoneRowBuilder } from './journal-row-builders'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { QueuedMessageHoldReason } from './queued-message-table'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  markJournalPendingSubmissionsUnknown,
  rejectJournalPendingSubmissions,
  rejectJournalQueuedSubmissions
} from './journal-pending-submission-recovery'
import { holdUnsentSends } from './journal-unsent-send-hold'
import { openJournalWriterSession } from './journal-writer-open'
import {
  journalSubmissionSelected,
  type JournalSubmissionSelector
} from './journal-submission-selector'
import { journalSqlFailure, type JournalSqlFailure } from './journal-sql-failure'
import type { QueuedMessageUpdate } from './queued-message-update'

/** Operations that run today's collaborator code; every host callback became data. */
export type JournalWriterInputOperation =
  | {
      kind: 'submission'
      input: JournalSubmissionInput
      /** `owed` asks the host, after validation, whether mail is still owed at handover. */
      consume?: Omit<JournalSubmissionConsume, 'owed'> & { owed?: true }
    }
  | { kind: 'accept-late'; input: Extract<ResolveDispatchInput, { state: 'accepted' }> }
  | {
      kind: 'queue-insert'
      input: {
        messageId: string
        body: AgentJournalMessageItem
        requireAttachments?: true
        holdReason?: QueuedMessageHoldReason
        options?: AgentSessionExecutionOptions
      }
    }
  | { kind: 'queue-update'; input: QueuedMessageUpdate }
  | { kind: 'queue-hold'; messageIds: readonly string[]; reason: QueuedMessageHoldReason }
  | { kind: 'queue-withdraw'; messageIds: readonly string[] }
  | { kind: 'queue-move'; input: { messageId: string } & AgentSessionQueuedMessageMoveAnchor }
  | { kind: 'queue-reopen-mark'; fence: number; since?: number }
  | { kind: 'pending-unknown'; fence: number; reason?: string }
  | { kind: 'pending-reject'; fence: number; rejection: AgentJournalDispatchRejection }
  | {
      kind: 'queued-reject'
      fence: number
      rejection: AgentJournalDispatchRejection
      select?: JournalSubmissionSelector
    }
  | {
      kind: 'hold-unsent'
      fence: number
      hold: { cause: 'hostRestarted' } | { cause: 'chatClosed'; select?: JournalSubmissionSelector }
      unrun?: true | JournalSubmissionSelector
    }
  | {
      kind: 'stop-accept'
      event: Omit<JournalStopEvent, 'at'>
      fence: number
      /** The host's current-work answer, read on its lane just before this command. */
      liveTurnId: string | null
    }
  | { kind: 'goal-withdraw'; identity: AgentJournalItemIdentity; fence: number }
  | {
      kind: 'item-claiming'
      identity: AgentJournalItemIdentity
      body: AgentJournalMessageItem
      options: JournalItemAppendOptions
    }
  | { kind: 'open' }

/** Recovery tries every send; earlier settlements stay committed when a later one fails, as they
 *  do on the host, so a failure is part of the answer rather than a rollback. */
export type JournalWriterSettled = { value: unknown } | { failure: JournalSqlFailure }

/** Runs one command's operation; `receipt` carries the host-computed effects into its row transaction. */
export async function runJournalWriterOperation(
  session: JournalWriterSession,
  operation: JournalWriterOperation,
  receipt: JournalOperationReceipt | undefined
): Promise<unknown> {
  const { collaborators } = session
  const { queuedMessages: queue, submissionWriter } = collaborators
  switch (operation.kind) {
    case 'submission': {
      let consume: JournalSubmissionConsume | undefined
      if (operation.consume) {
        const { owed, ...selection } = operation.consume
        consume = { ...selection, ...(owed ? { owed: session.owed } : {}) }
      }
      return submissionWriter.append(operation.input, consume, receipt)
    }
    case 'accept-late':
      queue.rederiveLegacyWitnesses()
      return submissionWriter.acceptLate(operation.input)
    case 'queue-insert':
      return queue.insert(operation.input, receipt)
    case 'queue-update':
      return queue.update(operation.input)
    case 'queue-hold':
      return queue.hold({ messageIds: operation.messageIds, reason: operation.reason })
    case 'queue-withdraw':
      return queue.withdraw(operation.messageIds, receipt)
    case 'queue-move':
      return queue.move(operation.input, receipt)
    case 'queue-reopen-mark': {
      if (!queue.awaitReopenMark()) {
        return null
      }
      const since = operation.since ?? session.state.lastSequence + 1
      await collaborators.rowWriter.append(
        journalQueueReopenRowBuilder(() => session.state, operation.fence, operation.since),
        receipt
      )
      return since
    }
    case 'pending-unknown':
      return settled(
        markJournalPendingSubmissionsUnknown(session.journal, operation.fence, operation.reason)
      )
    case 'pending-reject':
      return settled(
        rejectJournalPendingSubmissions(session.journal, operation.fence, operation.rejection)
      )
    case 'queued-reject':
      return settled(
        rejectJournalQueuedSubmissions(
          session.journal,
          operation.fence,
          operation.rejection,
          operation.select && journalSubmissionSelected(operation.select, session.cursor)
        )
      )
    case 'hold-unsent': {
      const { hold, unrun } = operation
      const which = hold.cause === 'chatClosed' && hold.select
      return settled(
        holdUnsentSends(session.journal, {
          fence: operation.fence,
          hold:
            hold.cause === 'chatClosed'
              ? {
                  cause: 'chatClosed',
                  ...(which ? { which: journalSubmissionSelected(which, session.cursor) } : {})
                }
              : hold,
          ...(unrun === undefined
            ? {}
            : { unrun: unrun === true || journalSubmissionSelected(unrun, session.cursor) })
        })
      )
    }
    case 'stop-accept':
      return collaborators.stops.accept(
        { event: operation.event, fence: operation.fence, liveTurnId: () => operation.liveTurnId },
        receipt
      )
    case 'goal-withdraw': {
      const goal = session.goalAttachments.withdraw(agentJournalItemKey(operation.identity))
      return collaborators.rowWriter.append(
        journalTombstoneRowBuilder(
          () => session.state,
          agentJournalItemKey(operation.identity),
          operation.fence
        ),
        receipt ? composeJournalOperationReceipts(goal, receipt) : goal
      )
    }
    case 'open':
      if (receipt) {
        throw new Error('journal opens carry no receipt')
      }
      return openJournalWriterSession(session)
    case 'item-claiming':
      if (receipt) {
        throw new Error('journal attachment-claiming items carry no receipt')
      }
      return collaborators.itemAppender.appendClaimingAttachments(
        operation.identity,
        operation.body,
        operation.options
      )
    case 'item':
      // Through the appender, so an independent user input claims its uploads as on the host.
      return collaborators.itemAppender.append(
        operation.identity,
        operation.body,
        operation.options,
        receipt
      )
    case 'tombstone':
      return collaborators.rowWriter.append(
        journalTombstoneRowBuilder(
          () => session.state,
          agentJournalItemKey(operation.identity),
          operation.fence
        ),
        receipt
      )
    case 'lifecycle':
      if (receipt) {
        throw new Error('journal lifecycle batches carry no receipt')
      }
      return collaborators.lifecycleBatchAppender.append(operation.input)
    case 'dispatch':
      if (!operation.onlyIfUnsettled && !receipt) {
        return submissionWriter.resolveDispatch(operation.input)
      }
      return cursorOf(
        collaborators.rowWriter.writeRows(
          () => planJournalWriterRows(session.state, operation),
          receipt
        )
      )
    case 'stop':
      return collaborators.rowWriter.append(
        journalStopEventRowBuilder(() => session.state, operation.event, operation.fence),
        receipt
      )
    case 'queue-resume':
      return collaborators.rowWriter.append(
        journalQueueResumeRowBuilder(() => session.state, operation.fence),
        receipt
      )
    case 'queue-reopen':
      return collaborators.rowWriter.append(
        journalQueueReopenRowBuilder(() => session.state, operation.fence, operation.since),
        receipt
      )
  }
}

function settled(run: Promise<unknown>): Promise<JournalWriterSettled> {
  return run.then(
    (value) => ({ value }),
    (error: unknown) => ({ failure: journalSqlFailure(error) })
  )
}

function cursorOf(rows: readonly JournalRow[]): AgentJournalCursor | null {
  const row = rows.at(-1)
  return row ? { epoch: row.epoch, sequence: row.seq } : null
}
