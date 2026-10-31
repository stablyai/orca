import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { renderJournalState, type JournalReducerState } from './journal-reducer'
import type { JournalWriteQueue } from './journal-write-queue'

export function closeJournalReadLifetime(
  queue: JournalWriteQueue,
  editLeases: { dispose: () => void },
  completeRead?: (() => void) | void
): Promise<void> {
  editLeases.dispose()
  if (completeRead) {
    completeRead()
  }
  queue.markClosed()
  return queue.drain()
}

/** Adoption revokes an unfinished borrow even when it restores the same epoch. */
export function captureJournalReadSource(read: () => JournalReducerState): () => boolean {
  const state = read()
  const epoch = state.epoch
  return () => read() === state && state.epoch === epoch
}

/** Only a committed journal owner can certify reuse across public reads. */
export function createJournalPublicReader() {
  let current:
    | {
        raw: JournalReducerState
        epoch: string
        sequence: number
        revision: string
        normalizationKey?: string
        view?: ReturnType<typeof readJournalPublicView>
      }
    | undefined
  return (raw: JournalReducerState, display: JournalReducerState, revision: string) => {
    const { epoch, lastSequence: sequence } = raw
    if (
      current?.raw !== raw ||
      current.epoch !== epoch ||
      current.sequence !== sequence ||
      current.revision !== revision
    ) {
      current = { raw, epoch, sequence, revision }
    }
    const source = current
    return (source.view ??= readJournalPublicView(
      display,
      () => (source.normalizationKey ??= journalNormalizationKey(display))
    ))
  }
}

/** Row progress cannot certify a historical display that the queue fold corrected. */
export function readJournalPublicView(
  state: JournalReducerState,
  normalizationKey = () => journalNormalizationKey(state)
): {
  snapshot: AgentJournalSnapshot
  normalizationKey: string
} {
  let snapshot: AgentJournalSnapshot | undefined
  return {
    get snapshot() {
      return (snapshot ??= renderJournalState(state))
    },
    get normalizationKey() {
      return normalizationKey()
    }
  }
}

function journalNormalizationKey(state: JournalReducerState): string {
  const corrections = [...state.normalizedHandOffs].sort().flatMap((id) => {
    const item = state.items.get(agentJournalSubmissionKey(id))
    const submission = state.submissions.get(id)
    return item && submission
      ? [[id, item.sequence, item.observedAt, item.turnScope, submission.queuedMessageId ?? null]]
      : []
  })
  return corrections.length === 0 ? '' : JSON.stringify([state.epoch, corrections])
}
