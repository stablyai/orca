import type { JournalQueuedMessagesDeps } from './journal-store-contracts'
import type { QueuedMessageRow } from './queued-message-table'
import { deriveQueuePauses, journalQueueSelectionKey } from './queued-message-pause'
import { journalMailSourceEligible } from './journal-mail-boundary'

export function journalQueueSelection(deps: JournalQueuedMessagesDeps) {
  return {
    mailEligible: (card: QueuedMessageRow) =>
      journalMailSourceEligible(
        deps.state().mailBoundary,
        card.mailSource,
        deps.queueOrigin?.() === 'fresh'
      ),
    revision: (revision: string, edits: number) =>
      journalQueueSelectionKey(
        deps.state(),
        JSON.stringify([revision, deps.state().mailBoundary, deps.queueOrigin?.()]),
        edits,
        deps.reopenFloor()
      ),
    pauses: (cards: readonly QueuedMessageRow[]) => {
      const state = deps.state()
      const pauses = deriveQueuePauses({
        epoch: state.epoch,
        marks: { ...state.queuePauseMarks, latestStop: state.queuePauseMarks.personalStop ?? null },
        latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
        cards,
        reopenFloor: deps.reopenFloor()
      })
      const intent = state.mailBoundary
      if (intent) {
        const stopped = pauses.findIndex((pause) => pause.reason === 'stopped')
        if (stopped !== -1) {
          pauses.splice(stopped, 1)
        }
      }
      if (intent?.status === 'held' && intent.stop) {
        pauses.unshift({
          reason: 'stopped',
          since: intent.stop && {
            epoch: intent.stop.epoch,
            sequence: intent.stop.sequence
          }
        })
      }
      return pauses
    }
  }
}
