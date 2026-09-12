import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { parsePtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import {
  durableRecordVersion,
  invalidJournal,
  requireRecord
} from './relay-pty-ownership-transfer-journal-record-validation'
import type { RelayPtyOwnershipTransferRecord } from './relay-pty-ownership-transfer-adapter-state'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import type { PtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import {
  parsePtyOwnershipCaptureBoundary,
  type PtyOwnershipCaptureBoundary
} from '../shared/pty-ownership-capture-boundary'

export const MAX_ISSUED_CAPTURE_BOUNDARIES = 32

export function encodeRelayPtyOwnershipCaptureJournal(
  transfer: RelayPtyOwnershipTransferRecord
): Pick<
  RelayPtyOwnershipTransferDurableRecord,
  'version' | 'captureJournalVersion' | 'captureBaseline' | 'issuedCaptureBoundaries'
> {
  const version = durableRecordVersion(transfer)
  if (!transfer.captureBaseline && !transfer.issuedCaptureBoundaries?.length) {
    return { version }
  }
  if (version < 4) {
    throw invalidJournal()
  }
  return {
    version: transfer.issuedCaptureBoundaries?.length ? (10 as const) : (9 as const),
    captureJournalVersion: version as 4 | 5 | 6 | 7 | 8,
    ...(transfer.captureBaseline
      ? { captureBaseline: structuredClone(transfer.captureBaseline) }
      : {}),
    ...(transfer.issuedCaptureBoundaries?.length
      ? { issuedCaptureBoundaries: structuredClone(transfer.issuedCaptureBoundaries) }
      : {})
  }
}

/** Keep the established mutation schema intact; older readers must reject captured journals. */
export function decodeRelayPtyOwnershipCaptureJournal(value: unknown): {
  record: Record<string, unknown>
  captureBaseline: PtyOwnershipCaptureBaseline | undefined
  issuedCaptureBoundaries?: readonly PtyOwnershipCaptureBoundary[]
} {
  const record = requireRecord(value)
  if (record.version !== 9 && record.version !== 10) {
    if (
      record.captureBaseline !== undefined ||
      record.captureJournalVersion !== undefined ||
      record.issuedCaptureBoundaries !== undefined
    ) {
      throw invalidJournal()
    }
    return { record, captureBaseline: undefined }
  }
  if (
    ![4, 5, 6, 7, 8].includes(Number(record.captureJournalVersion)) ||
    !Number.isSafeInteger(record.captureJournalVersion)
  ) {
    throw invalidJournal()
  }
  const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  let issuedCaptureBoundaries: PtyOwnershipCaptureBoundary[] | undefined
  if (record.version === 10) {
    if (
      !Array.isArray(record.issuedCaptureBoundaries) ||
      record.issuedCaptureBoundaries.length === 0 ||
      record.issuedCaptureBoundaries.length > MAX_ISSUED_CAPTURE_BOUNDARIES
    ) {
      throw invalidJournal()
    }
    issuedCaptureBoundaries = record.issuedCaptureBoundaries.map((boundary) =>
      parsePtyOwnershipCaptureBoundary(boundary, identity)
    )
    if (
      new Set(issuedCaptureBoundaries.map((boundary) => JSON.stringify(boundary))).size !==
        issuedCaptureBoundaries.length ||
      issuedCaptureBoundaries.some(
        (boundary) => boundary.throughSeq > Number(record.sourceOutputEndSeq)
      )
    ) {
      throw invalidJournal()
    }
  } else if (record.issuedCaptureBoundaries !== undefined) {
    throw invalidJournal()
  }
  const baseline =
    record.version === 10 && record.captureBaseline === undefined
      ? undefined
      : parsePtyOwnershipCaptureBaseline(record.captureBaseline, identity)
  if (
    baseline &&
    issuedCaptureBoundaries &&
    !issuedCaptureBoundaries.some(
      (boundary) => JSON.stringify(boundary) === JSON.stringify(baseline.boundary)
    )
  ) {
    throw invalidJournal()
  }
  if (
    !Number.isSafeInteger(record.sourceOutputEndSeq) ||
    (baseline && baseline.boundary.throughSeq > Number(record.sourceOutputEndSeq)) ||
    (baseline &&
      record.phase === 'committed' &&
      requireRecord(record.commitReceipt).acceptedSourceEndSeq !== baseline.boundary.throughSeq)
  ) {
    throw invalidJournal()
  }
  return {
    record: { ...record, version: record.captureJournalVersion },
    captureBaseline: baseline,
    ...(issuedCaptureBoundaries ? { issuedCaptureBoundaries } : {})
  }
}
