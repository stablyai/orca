import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { contextTransferLookup, deriveContextTransferState } from './context-transfer-state'
import type { ContextTransferDelivery, ContextTransferRecord } from './context-transfer-record'
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

const RECEIPT_SAVEPOINT = 'context_transfer_receipt'

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
  const base = rows.some(
    (row) =>
      row.kind === 'item' &&
      row.body.kind === 'status' &&
      isAgentSessionProviderContextBoundary(row.body.contextClear)
  )
    ? readContextTransfers(db, next.sessionId)
    : indexed
  // Copy the retained facts only when this batch actually writes one.
  let records: ContextTransferRecord[] | undefined
  const write = (record: ContextTransferRecord) => {
    records ??= [...base]
    writeContextTransfer(db, record, records)
    const index = records.findIndex((row) => row.id === record.id)
    if (index !== -1) {
      records[index] = record
    } else {
      records.push(record)
    }
  }
  // A lost outcome leaves the started write uncertain, so it can neither replay nor end the provider's events.
  const settle = (delivery: ContextTransferDelivery) => {
    db.exec(`SAVEPOINT ${RECEIPT_SAVEPOINT}`)
    try {
      write(delivery)
      db.exec(`RELEASE ${RECEIPT_SAVEPOINT}`)
    } catch (error) {
      db.exec(`ROLLBACK TO ${RECEIPT_SAVEPOINT}`)
      db.exec(`RELEASE ${RECEIPT_SAVEPOINT}`)
      console.warn('[agent-session-journal] saving a context delivery outcome failed:', {
        sessionId: next.sessionId,
        deliveryId: delivery.id,
        error
      })
    }
  }
  const owner = contextTransferOwner(db, next.sessionId)
  const state = deriveContextTransferState(base, owner?.providerHandleChain ?? [])
  const target = state.kind !== 'none' && state.kind !== 'unpublished' ? state.target : undefined
  if (!target) {
    return
  }
  const lookup = contextTransferLookup(base)
  const carriers = new Map(lookup.carriers)
  for (const row of rows) {
    if (
      row.kind === 'dispatch' &&
      row.state === 'pending' &&
      row.fence === (owner?.lease.runtimeFence ?? target.fence)
    ) {
      if (!target.firstInputId) {
        write({ ...target, firstInputId: row.clientMessageId })
      }
      const deliveries = carriers.get(row.clientMessageId) ?? []
      const started = deliveries.map((delivery) =>
        delivery.targetId === target.id && !delivery.writeStartedAt && !delivery.outcome
          ? { ...delivery, writeStartedAt: row.ts }
          : delivery
      )
      started.forEach((delivery, index) => {
        if (delivery !== deliveries[index]) {
          write(delivery)
        }
      })
      if (started.length) {
        carriers.set(row.clientMessageId, started)
      }
    }
  }
  for (const [carrierInputId, deliveries] of carriers) {
    const receipt = next.receipts.get(carrierInputId)
    const submission = next.submissions.get(carrierInputId)
    const accepted = receipt !== undefined && previous.receipts.get(carrierInputId) !== receipt
    if (
      !accepted &&
      submission?.dispatchState !== 'unknown' &&
      submission?.dispatchState !== 'rejected'
    ) {
      continue
    }
    for (const delivery of deliveries) {
      if (!delivery.writeStartedAt) {
        continue
      }
      const recipient = lookup.targets.get(delivery.targetId)
      const identity = accepted ? parseAgentJournalItemKey(receipt.providerItemId) : null
      const directCarrier =
        identity?.provider === 'orca' &&
        identity.clientMessageId === carrierInputId &&
        recipient?.id === target.id &&
        rows.some(
          (row) =>
            row.kind === 'dispatch' &&
            row.state === 'accepted' &&
            row.clientMessageId === carrierInputId &&
            row.fence === owner?.lease.runtimeFence
        )
      if (
        accepted &&
        identity &&
        recipient?.targetLink &&
        (directCarrier ||
          matchesContextTransferTarget({
            owner: () => owner,
            sessionId: next.sessionId,
            identity,
            handle: recipient.targetLink.handle,
            fence: submission?.fence
          }))
      ) {
        settle({
          ...delivery,
          outcome: {
            kind: 'inline-accepted',
            at: receipt.acceptedAt,
            clientMessageId: receipt.clientMessageId,
            providerItemIdentity: receipt.providerItemId
          }
        })
      } else if (submission?.dispatchState === 'unknown' && !delivery.outcome) {
        settle({
          ...delivery,
          outcome: { kind: 'unknown', at, reason: 'The carrier has no proved provider receipt' }
        })
      } else if (
        submission?.dispatchState === 'rejected' &&
        readWholeAgentSessionFailureFact(submission.rejection)?.neverReachedAgent === true
      ) {
        settle({
          ...delivery,
          outcome: { kind: 'refused-before-write', at, failureKind: 'carrier-refused' }
        })
      }
    }
  }
}
