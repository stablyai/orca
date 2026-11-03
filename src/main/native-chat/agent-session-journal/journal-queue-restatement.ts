import type { JournalReducerState } from './journal-reducer'
import type { LegacyQueuedCards } from './journal-queue-import'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import type { JournalQueueRestatement } from './journal-queued-messages'
import type { QueuedMessageRow } from './queued-message-table'
import { retainedQueueFactSteps } from './journal-queue-retention'
import { finishJournalStepsAsync, sortJournalSteps } from './journal-reconstruction-steps'
import { settleJournalCommitAsync } from './journal-row-writer'
import { deriveQueuePauseSteps, type DerivedQueuePause } from './queued-message-pause'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'

export async function journalQueuePausesAsync(
  state: JournalReducerState,
  legacy: LegacyQueuedCards,
  reopenFloor: AgentJournalCursor | null
): Promise<DerivedQueuePause[]> {
  return finishJournalStepsAsync(
    deriveQueuePauseSteps({
      epoch: state.epoch,
      marks: state.queuePauseMarks,
      latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
      cards: await journalQueueCardsAsync(state, legacy),
      reopenFloor
    })
  )
}

export async function journalQueueCardsAsync(
  state: JournalReducerState,
  legacy: LegacyQueuedCards
): Promise<readonly QueuedMessageRow[]> {
  const old = await legacy.cardsAsync()
  return finishJournalStepsAsync(
    sortJournalSteps(
      (function* () {
        yield* state.queue.cards.values()
        yield* old
      })(),
      (a, b) => a.position - b.position
    )
  )
}

export async function prepareJournalQueueRestatement(
  state: JournalReducerState,
  legacy: LegacyQueuedCards,
  claim: JournalAttachmentClaim
): Promise<JournalQueueRestatement> {
  const cards = await finishJournalStepsAsync(
    retainedQueueFactSteps(await journalQueueCardsAsync(state, legacy), state.submissions)
  )
  const deletion = await legacy.deletionOfAllAsync()
  const commits: (() => void)[] = []
  return {
    cards,
    receipt: {
      write: async (db) => {
        let work = 0
        for (const { change } of cards) {
          if (change?.op === 'queued') {
            const committed = await claim(db, change.body, false)
            if (committed) {
              commits.push(committed)
            }
          }
          if (++work === 128) {
            work = 0
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
        }
        await deletion.write(db)
      },
      committed: () =>
        settleJournalCommitAsync(
          (function* () {
            yield* commits
            yield () => deletion.committed()
          })()
        )
    }
  }
}
