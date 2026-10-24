import {
  journalItemEchoFields,
  journalItemEchoRestatement,
  type JournalItemEcho
} from './journal-item-echo'

import { sameJournalConversation } from './journal-history-origin'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'

import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
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
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { assertJournalFence } from './journal-write-guards'
import type { JournalOperationReceipt } from './journal-row-writer'

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

export function replaceJournalEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt
  previous?: JournalReducerState
  /** Preserve Stop/Resume state so rewinds cannot release held cards or resurrect lifted pauses. */
  queuePause: JournalQueuePauseRestatement
  /** Restate cards before carried submissions relink their handoffs. */
  queue: JournalQueueRestatement
  now: () => number
  mintEpoch: () => string
  /** Adopt committed state before fallible follow-up work. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const epoch = input.mintEpoch()
  const state = createJournalReducerState(input.identity.sessionId, epoch)
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
      ...(input.previous && input.reason !== 'legacy_import' && input.reason !== 'session_created'
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
    applyJournalRow(state, row)
    rows.push(row)
  }
  for (const { messageId, change } of input.queue.cards) {
    if (change) {
      const row = buildJournalQueueRow(
        state,
        messageId,
        change,
        state.lastSequence + 1,
        input.now()
      )
      applyJournalRow(state, row)
      rows.push(row)
    }
  }
  // Accepted-but-unhanded messages must survive provider history replacement.
  const queued = [...(input.previous?.submissions.values() ?? [])]
    .filter(isQueuedAgentJournalSubmission)
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
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
    applyJournalRow(state, row)
    rows.push(row)
  }
  const { lifted, liveStop, reopened } = input.queuePause
  const place = () => ({ state, seq: state.lastSequence + 1, fence: input.fence, ts: input.now() })
  if (lifted) {
    const row = buildJournalQueueResumeRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (liveStop) {
    const row = buildJournalStopEventRow({ ...place(), event: liveStop })
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (reopened) {
    const row = buildJournalQueueReopenRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (input.queuePause.cleared) {
    const row = buildJournalQueueClearRow({ ...place(), clear: input.queuePause.cleared })
    applyJournalRow(state, row)
    rows.push(row)
  }

  const { sessionId } = input.identity
  const receipt = input.receipt?.({ epoch, sequence: state.lastSequence })
  input.database.transaction((db) => {
    const retired = readJournalSessionEpoch(db, sessionId)
    if (retired !== null) {
      deleteJournalEpochRows(db, sessionId, retired)
    }
    for (const row of rows) {
      insertJournalRow(db, sessionId, row)
    }
    input.queue.receipt.write(db)
    publishJournalSessionEpoch(db, input.identity, epoch)
    receipt?.write(db)
  })
  input.queue.receipt.committed()

  // Adopt the committed epoch immediately; later failures must not leave writers targeting deleted rows.
  state.oldestSequence = 1
  input.onPublished({ state, newer: null, damage: null })
  receipt?.committed()
}
