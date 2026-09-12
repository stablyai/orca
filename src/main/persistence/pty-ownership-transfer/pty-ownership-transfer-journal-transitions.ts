import {
  parsePtyOwnershipTransferJournal,
  publicationReceiptMatchesPtyOwnershipTransfer,
  receiptMatchesPtyOwnershipTransfer,
  type PtyOwnershipTransferCommitReceipt,
  type PtyOwnershipTransferDestinationJournal,
  type PtyOwnershipTransferIdentity,
  type PtyOwnershipTransferJournal,
  type PtyOwnershipTransferPublicationReceipt,
  type PtyOwnershipTransferSourceJournal
} from '../../../shared/pty-ownership-transfer-journal'
import {
  samePtyOwnershipTransferCommitReceipt,
  samePtyOwnershipTransferPublicationReceipt
} from '../../../shared/pty-ownership-transfer-receipt-validation'

type TransitionOptions = { now?: () => Date }

export function advancePtyOwnershipTransferSourceOutput(
  current: PtyOwnershipTransferSourceJournal,
  sourceOutputEndSeq: number,
  options: TransitionOptions
): PtyOwnershipTransferSourceJournal {
  requireSequence(sourceOutputEndSeq, 'pty_ownership_transfer_source_output_invalid')
  if (current.phase !== 'prepared') {
    throw new Error('pty_ownership_transfer_source_cursor_advance_invalid')
  }
  if (sourceOutputEndSeq < current.sourceOutputEndSeq) {
    throw new Error('pty_ownership_transfer_source_cursor_conflict')
  }
  if (sourceOutputEndSeq === current.sourceOutputEndSeq) {
    return current
  }
  return parseSourceJournal({
    ...current,
    sourceOutputEndSeq,
    updatedAt: nowIso(options)
  })
}

export function advancePtyOwnershipTransferDestinationCursor(
  current: PtyOwnershipTransferDestinationJournal,
  acceptedSourceEndSeq: number,
  options: TransitionOptions
): PtyOwnershipTransferDestinationJournal {
  requireSequence(acceptedSourceEndSeq, 'pty_ownership_transfer_destination_cursor_invalid')
  if (current.phase !== 'prepared') {
    throw new Error('pty_ownership_transfer_destination_cursor_advance_invalid')
  }
  if (acceptedSourceEndSeq < current.acceptedSourceEndSeq) {
    throw new Error('pty_ownership_transfer_destination_cursor_conflict')
  }
  if (acceptedSourceEndSeq === current.acceptedSourceEndSeq) {
    return current
  }
  return parseDestinationJournal({
    ...current,
    acceptedSourceEndSeq,
    updatedAt: nowIso(options)
  })
}

export function commitPtyOwnershipTransferDestination(
  current: PtyOwnershipTransferDestinationJournal,
  identity: PtyOwnershipTransferIdentity,
  receipt: PtyOwnershipTransferCommitReceipt,
  options: TransitionOptions
): PtyOwnershipTransferDestinationJournal {
  if (current.phase === 'aborted') {
    throw new Error('pty_ownership_transfer_aborted_cannot_commit')
  }
  if (!receiptMatchesPtyOwnershipTransfer(receipt, identity, current.acceptedSourceEndSeq)) {
    throw new Error('pty_ownership_transfer_commit_receipt_invalid')
  }
  if (current.phase === 'committed' || current.phase === 'published') {
    if (!current.receipt || !samePtyOwnershipTransferCommitReceipt(current.receipt, receipt)) {
      throw new Error('pty_ownership_transfer_commit_receipt_changed')
    }
    return current
  }
  return parseDestinationJournal({
    ...current,
    phase: 'committed',
    receipt: structuredClone(receipt),
    updatedAt: nowIso(options)
  })
}

export function observePtyOwnershipTransferSourceCommit(
  current: PtyOwnershipTransferSourceJournal,
  identity: PtyOwnershipTransferIdentity,
  receipt: PtyOwnershipTransferCommitReceipt,
  options: TransitionOptions
): PtyOwnershipTransferSourceJournal {
  if (current.phase === 'aborted') {
    throw new Error('pty_ownership_transfer_aborted_cannot_commit')
  }
  if (!receiptMatchesPtyOwnershipTransfer(receipt, identity, receipt.acceptedSourceEndSeq)) {
    throw new Error('pty_ownership_transfer_commit_receipt_invalid')
  }
  if (receipt.acceptedSourceEndSeq > current.sourceOutputEndSeq) {
    throw new Error('pty_ownership_transfer_destination_output_ahead')
  }
  if (current.phase !== 'prepared') {
    if (!current.receipt || !samePtyOwnershipTransferCommitReceipt(current.receipt, receipt)) {
      throw new Error('pty_ownership_transfer_commit_receipt_changed')
    }
    return current
  }
  return parseSourceJournal({
    ...current,
    phase: 'commit-observed',
    destinationOutputEndSeq: receipt.acceptedSourceEndSeq,
    receipt: structuredClone(receipt),
    updatedAt: nowIso(options)
  })
}

export function publishPtyOwnershipTransferDestination(
  current: PtyOwnershipTransferDestinationJournal,
  identity: PtyOwnershipTransferIdentity,
  publicationReceipt: PtyOwnershipTransferPublicationReceipt
): PtyOwnershipTransferDestinationJournal {
  if (current.phase === 'published') {
    requireSamePublicationReceipt(current.publicationReceipt, publicationReceipt)
    return current
  }
  if (current.phase !== 'committed' || !current.receipt) {
    throw new Error('pty_ownership_transfer_destination_not_committed')
  }
  if (
    !publicationReceiptMatchesPtyOwnershipTransfer(publicationReceipt, identity, current.receipt)
  ) {
    throw new Error('pty_ownership_transfer_publication_receipt_invalid')
  }
  return parseDestinationJournal({
    ...current,
    phase: 'published',
    publicationReceipt: structuredClone(publicationReceipt),
    updatedAt: publicationReceipt.publishedAt
  })
}

export function observePtyOwnershipTransferSourcePublication(
  current: PtyOwnershipTransferSourceJournal,
  identity: PtyOwnershipTransferIdentity,
  publicationReceipt: PtyOwnershipTransferPublicationReceipt,
  options: TransitionOptions
): PtyOwnershipTransferSourceJournal {
  if (current.phase === 'publication-observed' || current.phase === 'retired') {
    requireSamePublicationReceipt(current.publicationReceipt, publicationReceipt)
    return current
  }
  if (current.phase !== 'commit-observed' || !current.receipt) {
    throw new Error('pty_ownership_transfer_source_not_committed')
  }
  if (
    !publicationReceiptMatchesPtyOwnershipTransfer(publicationReceipt, identity, current.receipt)
  ) {
    throw new Error('pty_ownership_transfer_publication_receipt_invalid')
  }
  if (current.destinationOutputEndSeq !== current.sourceOutputEndSeq) {
    throw new Error('pty_ownership_transfer_source_output_not_caught_up')
  }
  return parseSourceJournal({
    ...current,
    phase: 'publication-observed',
    publicationReceipt: structuredClone(publicationReceipt),
    updatedAt: nowIso(options)
  })
}

export function retirePtyOwnershipTransferSourceJournal(
  current: PtyOwnershipTransferSourceJournal,
  options: TransitionOptions
): PtyOwnershipTransferSourceJournal {
  if (current.phase === 'retired') {
    return current
  }
  if (current.phase !== 'publication-observed' || !current.publicationReceipt) {
    throw new Error('pty_ownership_transfer_source_publication_not_observed')
  }
  return parseSourceJournal({ ...current, phase: 'retired', updatedAt: nowIso(options) })
}

export function abortPtyOwnershipTransferJournal(
  current: PtyOwnershipTransferJournal,
  options: TransitionOptions
): PtyOwnershipTransferJournal {
  if (current.phase === 'aborted') {
    return current
  }
  if (current.phase !== 'prepared') {
    throw new Error('pty_ownership_transfer_committed_cannot_abort')
  }
  const aborted = { ...current, phase: 'aborted', updatedAt: nowIso(options) }
  return current.side === 'source' ? parseSourceJournal(aborted) : parseDestinationJournal(aborted)
}

function requireSamePublicationReceipt(
  current: PtyOwnershipTransferPublicationReceipt | undefined,
  candidate: PtyOwnershipTransferPublicationReceipt
): void {
  if (!current || !samePtyOwnershipTransferPublicationReceipt(current, candidate)) {
    throw new Error('pty_ownership_transfer_publication_receipt_changed')
  }
}

function parseSourceJournal(value: unknown): PtyOwnershipTransferSourceJournal {
  const journal = parsePtyOwnershipTransferJournal(value)
  if (journal.side !== 'source') {
    throw new Error('pty_ownership_transfer_source_side_invalid')
  }
  return journal
}

function parseDestinationJournal(value: unknown): PtyOwnershipTransferDestinationJournal {
  const journal = parsePtyOwnershipTransferJournal(value)
  if (journal.side !== 'destination') {
    throw new Error('pty_ownership_transfer_destination_side_invalid')
  }
  return journal
}

function nowIso(options: TransitionOptions): string {
  return (options.now ?? (() => new Date()))().toISOString()
}

function requireSequence(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(code)
  }
}
