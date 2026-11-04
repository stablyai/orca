import { finishJournalStepsAsync, sortJournalSteps } from './journal-reconstruction-steps'
import { journalInputOrder } from './journal-input-order'
import { publishJournalOutcomeEpochAsync } from './journal-outcome-write'
import { journalItemEchoFields, journalItemEchoRestatement } from './journal-item-echo'

import { sameJournalConversation } from './journal-history-origin'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'

import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  buildJournalItemRow,
  buildJournalSubmissionRow,
  journalRowBase
} from './journal-row-builders'
import { buildJournalQueueRow } from './journal-queue-events'
import {
  buildJournalQueueReopenRow,
  buildJournalQueueClearRow,
  buildJournalQueueResumeRow,
  buildJournalStopEventRow
} from './journal-stop-and-resume-rows'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence } from './journal-write-guards'
import { settleJournalCommitAsync } from './journal-row-writer'

import { copyJournalNativeStateSteps } from './journal-input-conversion'
import {
  prepareJournalAcceptance,
  prepareJournalQueueRebaseWithAcceptance
} from './journal-input-provenance'

export type { JournalReplacementItem } from './journal-epoch-replacement-contracts'
import type { JournalEpochReplacementInput } from './journal-epoch-replacement-contracts'

export function replaceJournalEpoch(
  database: JournalHostDatabase,
  prepare: () => JournalEpochReplacementInput | Promise<JournalEpochReplacementInput>
): Promise<void> {
  return database
    .transaction(
      async (db) => {
        const input = await prepare()
        function* queuedSubmissions() {
          const values: AgentJournalSubmission[] = []
          for (const submission of input.previous?.submissions.values() ?? []) {
            if (isQueuedAgentJournalSubmission(submission)) {
              values.push(submission)
            }
            yield
          }
          return yield* sortJournalSteps(
            values,
            (a, b) => a.submittedSequence! - b.submittedSequence!
          )
        }
        const queued = await finishJournalStepsAsync(queuedSubmissions())
        const ids: string[] = []
        let work = 0
        const rest = async () => {
          if (++work === 128) {
            work = 0
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
        }
        for (const submission of queued) {
          ids.push(submission.clientMessageId)
          await rest()
        }
        const acceptance = await prepareJournalAcceptance(db, input.identity.sessionId, ids)
        const epoch = input.mintEpoch()
        const state = createJournalReducerState(input.identity.sessionId, epoch)
        if (input.previous) {
          await finishJournalStepsAsync(copyJournalNativeStateSteps(input.previous, state))
        }
        await finishJournalStepsAsync(journalInputOrder(state).beginReconstructionSteps())
        const providerHandle = agentSessionJournalProviderHandle(input.identity)
        const previousOrigin = input.previous?.historyOrigin
        const restate =
          input.reason !== 'legacy_import' &&
          input.reason !== 'session_created' &&
          previousOrigin &&
          sameJournalConversation(previousOrigin.providerHandle, providerHandle)
        const epochRow: JournalRow = {
          kind: 'epoch',
          reason:
            input.reason === 'legacy_import' && input.items.length === 0
              ? 'session_created'
              : input.reason,
          providerHandle,
          ...(restate ? { historyOrigin: previousOrigin.raw } : {}),
          ...journalRowBase(epoch, 1, input.fence, input.now())
        }
        const rows: JournalRow[] = [epochRow]
        applyJournalRow(state, epochRow)
        const { lifted, liveStop, reopened, failureHeld } = input.queuePause
        const place = () => ({
          state,
          seq: state.lastSequence + 1,
          fence: input.fence,
          ts: input.now()
        })
        const resume = () => {
          const row = buildJournalQueueResumeRow(place())
          journalInputOrder(state).withAcceptance(acceptance, () => applyJournalRow(state, row))
          rows.push(row)
        }
        if (lifted && failureHeld) {
          resume()
        }
        for (const item of input.items) {
          await finishJournalStepsAsync(journalInputOrder(state).cards.ensureSteps(state))
          const row = buildJournalItemRow({
            state,
            identity: item.identity,
            body: item.body,
            ...journalItemEchoFields(item),
            ...(input.previous &&
            input.reason !== 'legacy_import' &&
            input.reason !== 'session_created'
              ? journalItemEchoRestatement(
                  input.previous.itemEchoes,
                  input.previous.aliases.get(agentJournalItemKey(item.identity)) ??
                    agentJournalItemKey(item.identity)
                )
              : {}),
            seq: state.lastSequence + 1,
            fence: input.fence,
            ownerFence: item.ownerFence,
            executionOwner: item.executionOwner,
            ts: item.observedAt ?? input.now(),
            linkage: item,
            turnScope: item.turnScope ?? state.derivedTurnScope.scopeFor(item.body)
          })
          assertJournalFence(row.fence, state.highestFence)
          journalInputOrder(state).withAcceptance(acceptance, () => applyJournalRow(state, row))
          rows.push(row)
          await rest()
        }
        const appendQueue = (
          messageId: string,
          change: Parameters<typeof buildJournalQueueRow>[2]
        ) => {
          const row = buildJournalQueueRow(
            state,
            messageId,
            change,
            state.lastSequence + 1,
            input.now()
          )
          journalInputOrder(state).withAcceptance(acceptance, () => applyJournalRow(state, row))
          rows.push(row)
        }
        const rebuilt = new Map<string, number>()
        for (const submission of queued) {
          await finishJournalStepsAsync(journalInputOrder(state).cards.ensureSteps(state))
          const body = input.previous?.items.get(
            agentJournalSubmissionKey(submission.clientMessageId)
          )?.body
          if (body?.kind !== 'message') {
            throw new Error('journal_queued_submission_body_missing')
          }
          const row = buildJournalSubmissionRow({
            ...submission,
            state,
            body,
            providerHandle: agentSessionJournalProviderHandle(input.identity),
            seq: state.lastSequence + 1,
            fence: input.fence,
            ts: submission.submittedAt
          })
          journalInputOrder(state).withAcceptance(acceptance, () => applyJournalRow(state, row))
          rows.push(row)
          rebuilt.set(submission.clientMessageId, row.seq)
          await rest()
        }
        const rebase = await prepareJournalQueueRebaseWithAcceptance(
          acceptance,
          epoch,
          input.previous?.epoch,
          queued,
          rebuilt,
          input.queue.cards
        )
        for (const { messageId, change } of input.queue.cards) {
          await rest()
          if (!change) {
            continue
          }
          await finishJournalStepsAsync(journalInputOrder(state).cards.ensureSteps(state))
          const prior = input.previous?.queue.cards.get(messageId)
          const queuedAt = change.op === 'queued' ? rebase(change.queuedAt) : null
          appendQueue(
            messageId,
            change.op === 'queued'
              ? {
                  ...change,
                  queuedAt,
                  ...(prior?.state === 'dispatched' && prior.consumedAs
                    ? { attempt: prior.consumedAs }
                    : {})
                }
              : change
          )
        }
        if (lifted && !failureHeld) {
          resume()
        }
        if (liveStop) {
          const row = buildJournalStopEventRow({ ...place(), event: liveStop })
          journalInputOrder(state).withAcceptance(acceptance, () => applyJournalRow(state, row))
          rows.push(row)
        }
        if (reopened) {
          const row = buildJournalQueueReopenRow(place())
          journalInputOrder(state).withAcceptance(acceptance, () => applyJournalRow(state, row))
          rows.push(row)
        }
        if (input.queuePause.cleared) {
          const row = buildJournalQueueClearRow({ ...place(), clear: input.queuePause.cleared })
          journalInputOrder(state).withAcceptance(acceptance, () => applyJournalRow(state, row))
          rows.push(row)
        }

        const order = journalInputOrder(state)
        await finishJournalStepsAsync(order.restoreSteps(state), (next) =>
          order.withAcceptance(acceptance, next)
        )
        await finishJournalStepsAsync(order.finishReconstructionSteps(state))
        const { sessionId } = input.identity
        const receipt = input.receipt?.({ epoch, sequence: state.lastSequence })
        const claimsCommitted: (() => void)[] = []
        state.oldestSequence = 1
        for (const row of rows) {
          await rest()
          const body = row.kind === 'item' || row.kind === 'submission' ? row.body : null
          if (
            body?.kind === 'message' &&
            body.role === 'user' &&
            !(row.kind === 'item' && input.isLiveGoal?.(row.itemId))
          ) {
            const commit = await input.claimAttachments?.(db, body, false)
            if (commit) {
              claimsCommitted.push(commit)
            }
          }
        }
        await input.queue.receipt.write(db)
        db.add({
          kind: 'epoch',
          sessionId,
          workspaceId: input.identity.workspaceId,
          epoch,
          expected: input.previous?.epoch
        })
        const publication = await publishJournalOutcomeEpochAsync(
          db,
          sessionId,
          state.epoch,
          rows,
          input.previous
        )
        await receipt?.write(db)
        return { input, publication, receipt, claimsCommitted }
      },
      false,
      ({ input, publication, receipt, claimsCommitted }) => {
        const state = publication.adopt()
        return settleJournalCommitAsync(
          (function* () {
            yield () => input.onPublished({ state, newer: null, damage: null })
            yield* claimsCommitted
            yield () => input.queue.receipt.committed()
            yield () => receipt?.committed()
            yield () => input.publish?.()
          })()
        )
      }
    )
    .then(() => undefined)
}
