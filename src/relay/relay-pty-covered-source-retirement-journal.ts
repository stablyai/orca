import {
  parsePtyOwnershipTransferCommitReceipt,
  parsePtyOwnershipTransferWireIdentity
} from '../shared/pty-ownership-transfer-wire'
import type { PtySourceDeliverySnapshot } from '../shared/pty-source-credit-contract'
import { parsePtyRetainedSourceDelivery } from '../shared/pty-retained-source-delivery'
import { decodeRelayPtyOwnershipCaptureJournal } from './relay-pty-ownership-transfer-capture-journal'
import { parseRelayPtyRawCaptureAnchors } from './relay-pty-raw-capture-anchor'
import { parseRelayPtyRawEmissionCheckpoint } from './relay-pty-raw-emission-checkpoint-codec'
import { deriveRelayPtySuccessorCaptureDelivery } from './relay-pty-ownership-transfer-capture-cursor'
import { parseRelayPtyCommittedSourceCutoff } from './relay-pty-committed-source-cutoff'
import {
  invalidJournal,
  requireRecord,
  sequence
} from './relay-pty-ownership-transfer-journal-record-validation'
import type { PtyOwnershipTransferCommitReceipt } from '../shared/pty-ownership-transfer-journal-contract'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'

export type RelayPtyCoveredSourceRetirement = Readonly<{
  phase: 'prepared' | 'retired'
  retirementRecordSha256: string
  modelSha256: string
  sourceOutputEndSeq: number
  receipt: PtyOwnershipTransferCommitReceipt
  delivery: PtySourceDeliverySnapshot
}>

/** Historical custody evidence only; live cancellation and connection authority are not restored. */
export function parseRelayPtyCoveredSourceRetirement(
  value: unknown,
  record: Record<string, unknown>
): RelayPtyCoveredSourceRetirement {
  const retirement = requireRecord(value)
  const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  const { captureBaseline, issuedCaptureBoundaries } = decodeRelayPtyOwnershipCaptureJournal(record)
  const receipt = parsePtyOwnershipTransferCommitReceipt(record.commitReceipt)
  const savedReceipt = parsePtyOwnershipTransferCommitReceipt(retirement.receipt)
  const cutoff = parseRelayPtyCommittedSourceCutoff(record.committedSourceOutputEndSeq, {
    ...record,
    phase: record.phase,
    sourceOutputEndSeq: sequence(record.sourceOutputEndSeq),
    commitReceipt: receipt
  })
  if (
    !captureBaseline ||
    cutoff === undefined ||
    !record.destinationClaim ||
    record.exit !== undefined ||
    (retirement.phase !== 'prepared' && retirement.phase !== 'retired') ||
    typeof retirement.retirementRecordSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(retirement.retirementRecordSha256) ||
    retirement.modelSha256 !== captureBaseline.modelSha256 ||
    retirement.sourceOutputEndSeq !== cutoff ||
    receipt.bridgeId !== identity.bridgeId ||
    receipt.acceptedSourceEndSeq !== captureBaseline.boundary.throughSeq ||
    JSON.stringify(savedReceipt) !== JSON.stringify(receipt)
  ) {
    throw invalidJournal()
  }
  const rawCaptureAnchors = parseRelayPtyRawCaptureAnchors(
    record.rawCaptureAnchors,
    identity,
    issuedCaptureBoundaries,
    captureBaseline
  )
  const rawEmissionCheckpoint = parseRelayPtyRawEmissionCheckpoint(
    record.rawEmissionCheckpoint,
    sequence(record.sourceOutputEndSeq)
  )
  const expected = deriveRelayPtySuccessorCaptureDelivery(
    { rawCaptureAnchors, rawEmissionCheckpoint },
    captureBaseline,
    cutoff
  )
  const delivery = parsePtyRetainedSourceDelivery(
    retirement.delivery,
    captureBaseline.boundary.delivery
  )
  if (!expected || delivery.receivedEndSu !== expected.receivedEndSu) {
    throw invalidJournal()
  }
  return Object.freeze({
    phase: retirement.phase,
    retirementRecordSha256: retirement.retirementRecordSha256,
    modelSha256: captureBaseline.modelSha256,
    sourceOutputEndSeq: cutoff,
    receipt: Object.freeze(savedReceipt),
    delivery
  })
}

export function encodeRelayPtyCoveredSourceRetirementJournal(
  record: RelayPtyOwnershipTransferDurableRecord,
  retirement: RelayPtyCoveredSourceRetirement
): RelayPtyOwnershipTransferDurableRecord {
  if (
    (record.version !== 9 && record.version !== 10) ||
    record.sourceDeliveryRetirement !== undefined ||
    record.coveredSourceDeliveryRetirement !== undefined ||
    record.retirementJournalVersion !== undefined
  ) {
    throw invalidJournal()
  }
  return {
    ...record,
    version: 12,
    retirementJournalVersion: record.version,
    coveredSourceDeliveryRetirement: parseRelayPtyCoveredSourceRetirement(retirement, record)
  }
}

export function decodeRelayPtyCoveredSourceRetirementJournal(record: Record<string, unknown>) {
  if (
    record.version !== 12 ||
    (record.retirementJournalVersion !== 9 && record.retirementJournalVersion !== 10) ||
    record.sourceDeliveryRetirement !== undefined
  ) {
    throw invalidJournal()
  }
  const { retirementJournalVersion, coveredSourceDeliveryRetirement, ...base } = record
  const decoded = { ...base, version: retirementJournalVersion }
  return {
    record: decoded,
    sourceDeliveryRetirement: undefined,
    coveredSourceDeliveryRetirement: parseRelayPtyCoveredSourceRetirement(
      coveredSourceDeliveryRetirement,
      decoded
    )
  }
}
