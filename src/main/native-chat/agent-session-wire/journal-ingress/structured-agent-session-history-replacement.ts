import type { JournalWriterContextOperation } from '../../agent-session-journal/journal-writer-command'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import type { StructuredAgentSessionSinkAdmission } from './structured-agent-session-event-sink'

export type StructuredAgentSessionHistoryReplacement = {
  operation: Omit<Extract<JournalWriterContextOperation, { kind: 'epoch-replace' }>, 'fence'> & {
    guard: NonNullable<Extract<JournalWriterContextOperation, { kind: 'epoch-replace' }>['guard']>
  }
  /** Upper bound for the items, guard and replacement envelope. */
  reservedBytes: number
  beforeRun: () => boolean
  onResolved: (outcome: 'committed' | 'dropped') => void
}

export function createStructuredAgentSessionHistoryReplacement(
  queue: StructuredAgentSessionSinkQueue
): (replacement: StructuredAgentSessionHistoryReplacement) => StructuredAgentSessionSinkAdmission {
  return ({ operation, reservedBytes, beforeRun, onResolved }) => {
    return queue.submit({
      bytes: reservedBytes,
      run: async (bound) => {
        if (!beforeRun()) {
          onResolved('dropped')
          return
        }
        const commit = await bound.journal.write({ ...operation, fence: bound.fence })
        onResolved(commit.dropped ? 'dropped' : 'committed')
        if (!commit.dropped) {
          bound.publish()
        }
      }
    })
  }
}
