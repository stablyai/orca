import { invalidJournal } from './relay-pty-ownership-transfer-journal-record-validation'

/** Historical destination custody at commit, not the subsequently growing destination journal end. */
export function parseRelayPtyCommittedSourceCutoff(
  value: unknown,
  record: {
    phase: unknown
    destinationDelegation?: unknown
    destinationOutputRetention?: unknown
    sourceOutputEndSeq: number
    commitReceipt?: { acceptedSourceEndSeq: number }
  }
): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    record.phase !== 'committed' ||
    !record.destinationDelegation ||
    record.destinationOutputRetention !== true ||
    !record.commitReceipt ||
    record.commitReceipt.acceptedSourceEndSeq > Number(value) ||
    Number(value) > record.sourceOutputEndSeq
  ) {
    throw invalidJournal()
  }
  return Number(value)
}
