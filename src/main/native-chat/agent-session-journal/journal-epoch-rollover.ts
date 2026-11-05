import { finishJournalStepsAsync } from './journal-reconstruction-steps'
import { journalInputOrder } from './journal-input-order'
// Delete and replace epochs atomically; retaining superseded rows would grow history without bound.

import { publishJournalOutcomeEpochAsync } from './journal-outcome-write'
import { journalRowSchemaVersion } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalQueueRow } from './journal-queue-events'
import type { JournalQueueCardChange } from './journal-queue-events'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { settleJournalCommitAsync } from './journal-row-writer'

export type JournalNewEpochInput = {
  identity: AgentSessionJournalIdentity
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  /** Unhanded cards wait again; replacement submissions may relink them. */
  queue: { cards: readonly JournalQueueCardChange[]; receipt: JournalOperationReceipt }
  /** The epoch the caller built from (null: none yet); a different stored epoch refuses. */
  expectedEpoch?: string | null
  /** Adopt committed state before fallible follow-up work. */
  onPublished: (loaded: JournalLoad) => void | Promise<void>
  publish?: () => void
}

export function publishNewEpoch(
  database: JournalHostDatabase,
  prepare: () => JournalNewEpochInput | Promise<JournalNewEpochInput>
): Promise<void> {
  return database
    .transaction(
      async (db) => {
        const input = await prepare()
        const row: JournalRow = {
          kind: 'epoch',
          reason: input.reason,
          providerHandle: agentSessionJournalProviderHandle(input.identity),
          v: journalRowSchemaVersion([]),
          epoch: input.epoch,
          seq: 1,
          fence: input.fence,
          ts: input.now
        }

        const { sessionId } = input.identity
        const state = createJournalReducerState(sessionId, input.epoch)
        applyJournalRow(state, row)
        const rows: JournalRow[] = [row]
        let work = 0
        for (const { messageId, change } of input.queue.cards) {
          if (++work === 128) {
            work = 0
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
          await finishJournalStepsAsync(journalInputOrder(state).cards.ensureSteps(state))
          if (change) {
            const card = buildJournalQueueRow(
              state,
              messageId,
              change,
              state.lastSequence + 1,
              input.now
            )
            applyJournalRow(state, card)
            rows.push(card)
          }
        }
        state.oldestSequence = 1
        await input.queue.receipt.write(db)
        db.add({
          kind: 'epoch',
          sessionId,
          workspaceId: input.identity.workspaceId,
          epoch: input.epoch,
          expected: input.expectedEpoch
        })
        const publication = await publishJournalOutcomeEpochAsync(db, sessionId, state.epoch, rows)
        return { input, publication }
      },
      false,
      ({ input, publication }) => {
        const state = publication.adopt()
        return settleJournalCommitAsync([
          () => input.onPublished({ state, newer: null, damage: null }),
          () => input.queue.receipt.committed(),
          () => input.publish?.()
        ])
      }
    )
    .then(() => undefined)
}
