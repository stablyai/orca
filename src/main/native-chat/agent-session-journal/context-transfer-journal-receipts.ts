import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { deriveContextTransferState } from './context-transfer-state'
import type { ContextTransferRecord } from './context-transfer-record'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { matchesContextTransferTarget } from './context-transfer-echo'
import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  readContextTransfers,
  writeContextTransfer,
  closeContextTransfers,
  contextTransferOwner
} from './context-transfer-repository'
import { isAgentSessionProviderContextBoundary } from '../../../shared/agent-session/agent-session-provider-context'

/** The reducer's acceptance, including late provider items, commits with its matching context receipt. */
export function writeContextTransferJournalReceipts(
  db: Database.Database,
  previous: JournalReducerState,
  next: JournalReducerState,
  rows: readonly JournalRow[],
  at: number,
  indexed: readonly ContextTransferRecord[]
): void {
  for (const row of rows) {
    if (
      row.kind === 'item' &&
      row.body.kind === 'status' &&
      isAgentSessionProviderContextBoundary(row.body.contextClear)
    ) {
      closeContextTransfers(
        db,
        next.sessionId,
        row.body.contextClear.operationId,
        'context-clear',
        at
      )
    }
  }
  const records = [
    ...(rows.some(
      (row) =>
        row.kind === 'item' &&
        row.body.kind === 'status' &&
        isAgentSessionProviderContextBoundary(row.body.contextClear)
    )
      ? readContextTransfers(db, next.sessionId)
      : indexed)
  ]
  const write = (record: ContextTransferRecord) => {
    writeContextTransfer(db, record, records)
    const index = records.findIndex((row) => row.id === record.id)
    if (index !== -1) {
      records[index] = record
    } else {
      records.push(record)
    }
  }
  const owner = contextTransferOwner(db, next.sessionId)
  const state = deriveContextTransferState(records, owner?.providerHandleChain ?? [])
  const target = state.kind !== 'none' && state.kind !== 'unpublished' ? state.target : undefined
  if (!target) {
    return
  }
  for (const row of rows) {
    if (
      row.kind === 'dispatch' &&
      row.state === 'pending' &&
      row.fence === (owner?.lease.runtimeFence ?? target.fence)
    ) {
      if (!target.firstInputId) {
        write({ ...target, firstInputId: row.clientMessageId })
      }
      for (const delivery of records) {
        if (
          delivery.kind === 'delivery' &&
          delivery.targetId === target.id &&
          delivery.mode === 'inline' &&
          delivery.carrierInputId === row.clientMessageId &&
          !delivery.writeStartedAt &&
          !delivery.outcome
        ) {
          write({ ...delivery, writeStartedAt: row.ts })
        }
      }
    }
  }
  for (const delivery of records) {
    if (
      delivery.kind !== 'delivery' ||
      delivery.mode !== 'inline' ||
      !delivery.carrierInputId ||
      !delivery.writeStartedAt ||
      (delivery.outcome !== null && delivery.outcome.kind !== 'unknown')
    ) {
      continue
    }
    const receipt = next.receipts.get(delivery.carrierInputId)
    const recipient = records.find((row) => row.kind === 'target' && row.id === delivery.targetId)
    const identity = receipt && parseAgentJournalItemKey(receipt.providerItemId)
    const directCarrier =
      identity?.provider === 'orca' &&
      identity.clientMessageId === delivery.carrierInputId &&
      recipient?.id === target.id &&
      rows.some(
        (row) =>
          row.kind === 'dispatch' &&
          row.state === 'accepted' &&
          row.clientMessageId === delivery.carrierInputId &&
          row.fence === owner?.lease.runtimeFence
      )
    if (
      receipt &&
      identity &&
      recipient?.kind === 'target' &&
      recipient.targetLink &&
      (directCarrier ||
        matchesContextTransferTarget({
          owner: () => owner,
          sessionId: next.sessionId,
          identity,
          handle: recipient.targetLink.handle,
          fence: next.submissions.get(delivery.carrierInputId)?.fence
        })) &&
      previous.receipts.get(delivery.carrierInputId) !== receipt
    ) {
      write({
        ...delivery,
        outcome: {
          kind: 'inline-accepted',
          at: receipt.acceptedAt,
          clientMessageId: receipt.clientMessageId,
          providerItemIdentity: receipt.providerItemId
        }
      })
    } else {
      const submission = next.submissions.get(delivery.carrierInputId)
      if (submission?.dispatchState === 'unknown' && !delivery.outcome) {
        write({
          ...delivery,
          outcome: { kind: 'unknown', at, reason: 'The carrier has no proved provider receipt' }
        })
      } else if (
        submission?.dispatchState === 'rejected' &&
        readWholeAgentSessionFailureFact(submission.rejection)?.neverReachedAgent === true
      ) {
        write({
          ...delivery,
          outcome: { kind: 'refused-before-write', at, failureKind: 'carrier-refused' }
        })
      }
    }
  }
}
