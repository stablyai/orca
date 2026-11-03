import { journalInputOrder } from './journal-input-order'
import { publishJournalOutcomeEpochAsync } from './journal-outcome-write'
import {
  journalItemEchoFields,
  journalItemEchoRestatement,
  type JournalItemEcho
} from './journal-item-echo'

import { sameJournalConversation } from './journal-history-origin'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'

import type {
  AgentJournalCursor,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import {
  buildJournalItemRow,
  buildJournalSubmissionRow,
  journalRowBase
} from './journal-row-builders'
import { buildJournalQueueRow } from './journal-queue-events'
import type { JournalQueueRestatement } from './journal-queued-messages'
import {
  buildJournalQueueReopenRow,
  buildJournalQueueClearRow,
  buildJournalQueueResumeRow,
  buildJournalStopEventRow
} from './journal-stop-and-resume-rows'
import type { JournalQueuePauseRestatement } from './queued-message-pause'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { assertJournalFence } from './journal-write-guards'
import { settleJournalCommit, type JournalOperationReceipt } from './journal-row-writer'

import type { JournalAttachmentClaim } from './journal-submission-hook'
import { copyJournalNativeState } from './journal-input-conversion'
import {
  prepareJournalAcceptance,
  journalQueueRebaseWithAcceptance
} from './journal-input-provenance'

export type JournalReplacementItem = AgentJournalProducerLinkage & {
  echoOf?: JournalItemEcho['echoOf']
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
  /** Derive absent legacy scopes from timeline position before persisting them. */
  turnScope?: AgentJournalTurnScope
  /** Preserve original execution provenance; history replacement is not new work. */
  ownerFence: number
  executionOwner?: number
}

/** Survivors are restated from the open chat. That loses nothing another build wrote: a chat holding
 * a key this build does not declare refuses to open, so no handle can reach here. */
export type JournalEpochReplacementInput = {
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  /** The caller's completion receipt writes after the new epoch's records, in the same
   * transaction, so it can restore the replaced conversation on `db`. */
  receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt
  isLiveGoal?: (id: string) => boolean
  claimAttachments?: JournalAttachmentClaim
  previous?: JournalReducerState
  /** Preserve Stop/Resume state so rewinds cannot release held cards or resurrect lifted pauses. */
  queuePause: JournalQueuePauseRestatement
  /** Restate cards before carried submissions relink their handoffs. */
  queue: JournalQueueRestatement
  now: () => number
  mintEpoch: () => string
  /** Adopt committed state before fallible follow-up work. */
  onPublished: (loaded: JournalLoad) => void
  publish?: () => void
}

export function replaceJournalEpoch(
  database: JournalHostDatabase,
  prepare: () => JournalEpochReplacementInput
): Promise<void> {
  return database
    .transaction(
      async (db) => {
        const input = prepare()
        const queued = [...(input.previous?.submissions.values() ?? [])]
          .filter(isQueuedAgentJournalSubmission)
          .sort((a, b) => a.submittedSequence! - b.submittedSequence!)
        const acceptance = await prepareJournalAcceptance(
          db,
          input.identity.sessionId,
          queued.map((submission) => submission.clientMessageId)
        )
        const epoch = input.mintEpoch()
        const state = createJournalReducerState(input.identity.sessionId, epoch)
        if (input.previous) {
          copyJournalNativeState(input.previous, state)
        }
        journalInputOrder(state).beginReconstruction()
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
        for (const item of input.items) {
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
        }
        const rebase = journalQueueRebaseWithAcceptance(
          acceptance,
          epoch,
          input.previous?.epoch,
          queued,
          rebuilt
        )
        for (const { messageId, change } of input.queue.cards) {
          if (!change) {
            continue
          }
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
        const { lifted, liveStop, reopened } = input.queuePause
        const place = () => ({
          state,
          seq: state.lastSequence + 1,
          fence: input.fence,
          ts: input.now()
        })
        if (lifted) {
          const row = buildJournalQueueResumeRow(place())
          journalInputOrder(state).withAcceptance(acceptance, () => applyJournalRow(state, row))
          rows.push(row)
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

        journalInputOrder(state).restore(state)
        journalInputOrder(state).finishReconstruction(state)
        const { sessionId } = input.identity
        const receipt = input.receipt?.({ epoch, sequence: state.lastSequence })
        const claimsCommitted: (() => void)[] = []
        state.oldestSequence = 1
        for (const row of rows) {
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
        settleJournalCommit(
          () => input.onPublished({ state, newer: null, damage: null }),
          ...claimsCommitted,
          () => input.queue.receipt.committed(),
          () => receipt?.committed(),
          () => input.publish?.()
        )
      }
    )
    .then(() => undefined)
}
