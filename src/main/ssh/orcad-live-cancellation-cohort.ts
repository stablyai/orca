import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { listValidatedOrcadLiveCancellationRecoveryReceipts } from './orcad-live-cancellation-recovery-receipts'
import {
  OrcadLiveSourceRetirementRecordStore,
  parseOrcadLiveSourceRetirementRecord
} from './orcad-live-source-retirement-record'

/** Complete durable cancellation history, not current owner or runtime-cleanup authority. */
export function bindOrcadLiveCancellationCohort(profileDirectory: string, value: unknown) {
  const record = parseOrcadLiveSourceRetirementRecord(value)
  const expectedRecord = serializeOrcadMigrationValue(record)
  const records = new OrcadLiveSourceRetirementRecordStore(profileDirectory)
  const readCohort = () => {
    if (serializeOrcadMigrationValue(records.read(record.identity)) !== expectedRecord) {
      throw new Error('orcad_live_cancellation_cohort_record_changed')
    }
    const receipts = listValidatedOrcadLiveCancellationRecoveryReceipts(profileDirectory)
      .filter((entry) => entry.record.sha256 === record.sha256)
      .map((entry) => entry.receipt)
    const bindings = record.release.cutover.liveTerminalBindings!
    const ordered = bindings.map(({ identity }) => {
      const matches = receipts.filter((receipt) =>
        samePtyOwnershipTransferIdentity(receipt.identity, identity)
      )
      if (matches.length !== 1) {
        throw new Error('orcad_live_cancellation_cohort_incomplete')
      }
      return matches[0]
    })
    if (new Set(ordered).size !== bindings.length || receipts.length !== bindings.length) {
      throw new Error('orcad_live_cancellation_cohort_conflict')
    }
    return ordered
  }
  const receipts = readCohort()
  const expectedReceipts = serializeOrcadMigrationValue(receipts)
  return {
    receipts,
    assertCancellation(candidate: unknown) {
      if (
        serializeOrcadMigrationValue(parseOrcadLiveSourceRetirementRecord(candidate)) !==
        expectedRecord
      ) {
        throw new Error('orcad_live_cancellation_cohort_record_changed')
      }
      if (serializeOrcadMigrationValue(readCohort()) !== expectedReceipts) {
        throw new Error('orcad_live_cancellation_cohort_receipts_changed')
      }
    }
  }
}
