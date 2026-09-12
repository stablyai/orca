import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import { parseOrcadLiveSourceCleanupIntent } from './orcad-live-source-cleanup-intent'
import {
  createOrcadLiveRuntimeCleanupCheckpoint,
  parseOrcadLiveRuntimeCleanupCheckpoint,
  listValidatedOrcadLiveRuntimeCleanupCheckpoints
} from './orcad-live-runtime-cleanup-checkpoint'
import {
  createOrcadLiveCleanupOutputEvidence,
  listValidatedOrcadLiveCleanupOutputEvidence
} from './orcad-live-cleanup-output-evidence'
import {
  createOrcadLiveSourceCancellationReceipt,
  parseOrcadLiveSourceCancellationReceipt,
  OrcadLiveSourceCancellationReceiptStore
} from './orcad-live-source-cancellation-receipt'

/** Structural parsing only; the referenced record determines complete cohort coverage. */
export function parseOrcadLiveSourceCompletionPreparation(value: unknown) {
  const parsed = z
    .object({
      phase: z.literal('source-completion-prepared'),
      checkpoint: z.unknown(),
      receipts: z.array(z.unknown()).min(1)
    })
    .passthrough()
    .parse(value)
  const header = parseOrcadLiveSourceCleanupIntent({ ...parsed, phase: 'cleanup-prepared' })
  const checkpoint = parseOrcadLiveRuntimeCleanupCheckpoint(parsed.checkpoint)
  const receipts = parsed.receipts.map(parseOrcadLiveSourceCancellationReceipt)
  const bridges = new Set<string>()
  if (
    checkpoint.retirementRecordSha256 !== header.retirementRecordSha256 ||
    checkpoint.migrationId !== header.migrationId ||
    !samePtyOwnershipTransferIdentity(checkpoint.identity, header.identity) ||
    !samePtyOwnershipTransferIdentity(receipts[0].identity, header.identity) ||
    receipts.some((receipt) => {
      const duplicate = bridges.has(receipt.identity.bridgeId)
      bridges.add(receipt.identity.bridgeId)
      return (
        duplicate ||
        receipt.migrationId !== header.migrationId ||
        receipt.retirement.sourceDeliveryRetirement.retirementRecordSha256 !==
          header.retirementRecordSha256
      )
    })
  ) {
    throw new Error('orcad_live_source_completion_preparation_conflict')
  }
  return { ...header, phase: 'source-completion-prepared' as const, checkpoint, receipts }
}

export function createOrcadLiveSourceCompletionPreparation(options: {
  record: unknown
  checkpoint: unknown
  settlements: unknown
  receipts: unknown
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const checkpoint = parseOrcadLiveRuntimeCleanupCheckpoint(options.checkpoint)
  if (
    serializeOrcadMigrationValue(checkpoint) !==
    serializeOrcadMigrationValue(createOrcadLiveRuntimeCleanupCheckpoint(record))
  ) {
    throw new Error('orcad_live_source_completion_checkpoint_conflict')
  }
  const output = createOrcadLiveCleanupOutputEvidence(record, options.settlements)
  const supplied = z
    .array(z.unknown())
    .parse(options.receipts)
    .map(parseOrcadLiveSourceCancellationReceipt)
  const bindings = record.release.cutover.liveTerminalBindings!
  if (supplied.length !== bindings.length) {
    throw new Error('orcad_live_source_completion_receipts_incomplete')
  }
  const receipts = bindings.map(({ identity }) => {
    const matches = supplied.filter((receipt) =>
      samePtyOwnershipTransferIdentity(receipt.identity, identity)
    )
    if (matches.length !== 1) {
      throw new Error('orcad_live_source_completion_receipts_incomplete')
    }
    const receipt = matches[0]
    const expected = createOrcadLiveSourceCancellationReceipt({
      record,
      settlements: output.settlements,
      retirement: receipt.retirement,
      cancellation: receipt.cancellation
    })
    if (serializeOrcadMigrationValue(expected) !== serializeOrcadMigrationValue(receipt)) {
      throw new Error('orcad_live_source_completion_receipt_conflict')
    }
    return expected
  })
  return parseOrcadLiveSourceCompletionPreparation({
    ...checkpoint,
    phase: 'source-completion-prepared',
    checkpoint,
    receipts
  })
}

/** Prepared route-cleanup evidence, never completed source retirement or permission to delete artifacts. */
export class OrcadLiveSourceCompletionPreparationStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveSourceCompletionPreparation>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-source-completion-preparations'),
      parseOrcadLiveSourceCompletionPreparation,
      'orcad_live_source_completion_preparation'
    )
  }
}

export function listValidatedOrcadLiveSourceCompletionPreparations(
  profileDirectory: string,
  outputs = listValidatedOrcadLiveCleanupOutputEvidence(profileDirectory),
  checkpoints = listValidatedOrcadLiveRuntimeCleanupCheckpoints(profileDirectory)
) {
  const receipts = new OrcadLiveSourceCancellationReceiptStore(profileDirectory)
  return new OrcadLiveSourceCompletionPreparationStore(profileDirectory)
    .list()
    .map((preparation) => {
      const matches = outputs.filter(
        ({ record }) => record.sha256 === preparation.retirementRecordSha256
      )
      const cleanup = checkpoints.filter(
        ({ record }) => record.sha256 === preparation.retirementRecordSha256
      )
      if (matches.length !== 1 || cleanup.length !== 1) {
        throw new Error('orcad_live_source_completion_preparation_orphaned')
      }
      const { record, evidence } = matches[0]
      if (
        preparation.receipts.some(
          (receipt) =>
            serializeOrcadMigrationValue(receipts.read(receipt.identity)) !==
            serializeOrcadMigrationValue(receipt)
        )
      ) {
        throw new Error('orcad_live_source_completion_receipt_conflict')
      }
      const expected = createOrcadLiveSourceCompletionPreparation({
        record,
        checkpoint: cleanup[0].checkpoint,
        settlements: evidence.settlements,
        receipts: preparation.receipts
      })
      if (serializeOrcadMigrationValue(expected) !== serializeOrcadMigrationValue(preparation)) {
        throw new Error('orcad_live_source_completion_preparation_conflict')
      }
      return { record, preparation }
    })
}
