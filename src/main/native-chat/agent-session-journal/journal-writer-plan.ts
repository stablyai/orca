import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import type { JournalWriterCoreOperation } from './journal-writer-command'
import type { JournalRow } from './journal-row-schema'
import {
  journalDispatchRowBuilder,
  journalItemRowBuilder,
  journalTombstoneRowBuilder
} from './journal-row-builders'
import {
  journalQueueReopenRowBuilder,
  journalQueueResumeRowBuilder,
  journalStopEventRowBuilder
} from './journal-stop-and-resume-rows'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'

/** State-dependent planning runs inside the command SAVEPOINT, after earlier surviving commands. */
export function planJournalWriterRows(
  state: JournalReducerState,
  operation: JournalWriterCoreOperation
): ((seq: number, ts: number) => JournalRow)[] {
  const current = () => state
  switch (operation.kind) {
    case 'item':
      return [journalItemRowBuilder(current, operation.identity, operation.body, operation.options)]
    case 'tombstone':
      return [
        journalTombstoneRowBuilder(
          current,
          agentJournalItemKey(operation.identity),
          operation.fence
        )
      ]
    case 'dispatch':
      return operation.onlyIfUnsettled &&
        !journalDispatchRowApplies(state.submissions.get(operation.input.clientMessageId))
        ? []
        : [journalDispatchRowBuilder(current, operation.input)]
    case 'stop':
      return [journalStopEventRowBuilder(current, operation.event, operation.fence)]
    case 'queue-resume':
      return [journalQueueResumeRowBuilder(current, operation.fence)]
    case 'queue-reopen':
      return [journalQueueReopenRowBuilder(current, operation.fence, operation.since)]
    case 'lifecycle':
      return new JournalLifecycleBatchAppender({
        state: current,
        cursor: () => ({ epoch: state.epoch, sequence: state.lastSequence }),
        enqueueRows: () => {
          throw new Error('journal SQL planner cannot enqueue another transaction')
        }
      }).plan(operation.input)
  }
}
