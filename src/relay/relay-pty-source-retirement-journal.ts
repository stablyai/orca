import { parsePtyOwnershipCaptureBoundary } from '../shared/pty-ownership-capture-boundary'
import {
  decodeRelayPtyCoveredSourceRetirementJournal,
  encodeRelayPtyCoveredSourceRetirementJournal,
  type RelayPtyCoveredSourceRetirement
} from './relay-pty-covered-source-retirement-journal'
import { parsePtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import type { PtySourceDeliverySnapshot } from '../shared/pty-source-credit-contract'
import {
  invalidJournal,
  requireRecord
} from './relay-pty-ownership-transfer-journal-record-validation'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'

export type RelayPtySourceRetirement = Readonly<{
  phase: 'prepared' | 'retired'
  retirementRecordSha256: string
  delivery: PtySourceDeliverySnapshot
}>

export function parseRelayPtySourceRetirement(
  value: unknown,
  record: Record<string, unknown>
): RelayPtySourceRetirement {
  const retirement = requireRecord(value)
  if (
    record.phase !== 'committed' ||
    !record.destinationDelegation ||
    !record.commitReceipt ||
    (retirement.phase !== 'prepared' && retirement.phase !== 'retired') ||
    typeof retirement.retirementRecordSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(retirement.retirementRecordSha256)
  ) {
    throw invalidJournal()
  }
  const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  // Reuse exact drained-delivery validation; no transfer-output cursor is inferred here.
  const { delivery } = parsePtyOwnershipCaptureBoundary(
    {
      version: 1,
      identity,
      throughSeq: 0,
      delivery: retirement.delivery
    },
    identity
  )
  return Object.freeze({
    phase: retirement.phase,
    retirementRecordSha256: retirement.retirementRecordSha256,
    delivery
  })
}

/** The outer version prevents an older relay from silently dropping retirement progress. */
export function encodeRelayPtySourceRetirementJournal(
  record: RelayPtyOwnershipTransferDurableRecord,
  retirement: RelayPtySourceRetirement | undefined,
  covered?: RelayPtyCoveredSourceRetirement
): RelayPtyOwnershipTransferDurableRecord {
  if (covered) {
    if (retirement) {
      throw invalidJournal()
    }
    return encodeRelayPtyCoveredSourceRetirementJournal(record, covered)
  }
  if (!retirement) {
    return record
  }
  if (record.version < 5 || record.version > 10) {
    throw invalidJournal()
  }
  return {
    ...record,
    version: 11,
    retirementJournalVersion: record.version as 5 | 6 | 7 | 8 | 9 | 10,
    sourceDeliveryRetirement: parseRelayPtySourceRetirement(retirement, record)
  }
}

export function decodeRelayPtySourceRetirementJournal(value: unknown) {
  const record = requireRecord(value)
  if (record.version === 12) {
    return decodeRelayPtyCoveredSourceRetirementJournal(record)
  }
  if (record.coveredSourceDeliveryRetirement !== undefined) {
    throw invalidJournal()
  }
  if (record.version !== 11) {
    if (
      record.retirementJournalVersion !== undefined ||
      record.sourceDeliveryRetirement !== undefined
    ) {
      throw invalidJournal()
    }
    return {
      record,
      sourceDeliveryRetirement: undefined,
      coveredSourceDeliveryRetirement: undefined
    }
  }
  if (
    !Number.isSafeInteger(record.retirementJournalVersion) ||
    ![5, 6, 7, 8, 9, 10].includes(Number(record.retirementJournalVersion))
  ) {
    throw invalidJournal()
  }
  const { retirementJournalVersion, sourceDeliveryRetirement, ...base } = record
  const decoded = { ...base, version: retirementJournalVersion }
  return {
    record: decoded,
    coveredSourceDeliveryRetirement: undefined,
    sourceDeliveryRetirement: parseRelayPtySourceRetirement(sourceDeliveryRetirement, decoded)
  }
}
