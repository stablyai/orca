import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { OrcadLiveSourceRetirementRecordStore } from './orcad-live-source-retirement-record'
import { listValidatedOrcadLiveCleanupOutputEvidence } from './orcad-live-cleanup-output-evidence'
import {
  createOrcadLiveSourceCancellationReceipt,
  parseOrcadLiveSourceCancellationReceipt
} from './orcad-live-source-cancellation-receipt'
import {
  parseOrcadLiveCoveredCancellationReceipt,
  validateOrcadLiveCoveredCancellationReceipt
} from './orcad-live-covered-cancellation-receipt'

export function parseOrcadLiveCancellationRecoveryReceipt(value: unknown) {
  const { version } = z.object({ version: z.union([z.literal(1), z.literal(2)]) }).parse(value)
  return version === 1
    ? parseOrcadLiveSourceCancellationReceipt(value)
    : parseOrcadLiveCoveredCancellationReceipt(value)
}

/** Discovery accepts both histories; neither grants current retirement authority. */
export function listValidatedOrcadLiveCancellationRecoveryReceipts(
  profileDirectory: string,
  records = new OrcadLiveSourceRetirementRecordStore(profileDirectory).list(),
  outputs = listValidatedOrcadLiveCleanupOutputEvidence(profileDirectory)
) {
  const receipts = new OrcadOutgoingEvidenceStore(
    join(profileDirectory, 'orcad-live-source-cancellation-receipts'),
    parseOrcadLiveCancellationRecoveryReceipt,
    'orcad_live_cancellation_recovery_receipt'
  ).list()
  const captures = new OrcadOutgoingCaptureStore(profileDirectory)
  return receipts.map((receipt) => {
    const hash =
      receipt.version === 1
        ? receipt.retirement.sourceDeliveryRetirement.retirementRecordSha256
        : receipt.request.retirementRecordSha256
    const matches = records.filter((record) => record.sha256 === hash)
    if (matches.length !== 1) {
      throw new Error('orcad_live_cancellation_recovery_record_conflict')
    }
    const record = matches[0]
    if (receipt.version === 2) {
      const capture = captures.read(receipt.identity)
      if (!capture) {
        throw new Error('orcad_live_cancellation_recovery_capture_missing')
      }
      return {
        record,
        receipt: validateOrcadLiveCoveredCancellationReceipt(receipt, record, capture)
      }
    }
    const settled = outputs.filter(({ record: candidate }) => candidate.sha256 === hash)
    if (
      settled.length !== 1 ||
      !record.release.cutover.liveTerminalBindings!.some(({ identity }) =>
        samePtyOwnershipTransferIdentity(identity, receipt.identity)
      )
    ) {
      throw new Error('orcad_live_source_cancellation_receipt_conflict')
    }
    const expected = createOrcadLiveSourceCancellationReceipt({
      record,
      settlements: settled[0].evidence.settlements,
      retirement: receipt.retirement,
      cancellation: receipt.cancellation
    })
    if (serializeOrcadMigrationValue(expected) !== serializeOrcadMigrationValue(receipt)) {
      throw new Error('orcad_live_cancellation_recovery_receipt_conflict')
    }
    return { record, receipt: expected }
  })
}
