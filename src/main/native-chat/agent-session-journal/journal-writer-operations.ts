import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import type { AgentSessionQueuedMessageMoveAnchor } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { JournalRow } from './journal-row-schema'
import type { JournalOperationReceipt } from './journal-row-writer'
import type {
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
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { QueuedMessageHoldReason } from './queued-message-table'
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
      const { consume } = operation
      const { owed, ...selection } = consume ?? {}
      return submissionWriter.append(
        operation.input,
        consume
          ? { ...(selection as JournalSubmissionConsume), ...(owed ? { owed: session.owed } : {}) }
          : undefined,
        receipt
      )
    }
    case 'accept-late':
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

function cursorOf(rows: readonly JournalRow[]): AgentJournalCursor | null {
  const row = rows.at(-1)
  return row ? { epoch: row.epoch, sequence: row.seq } : null
}
