import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferSourceRetirementEvidence } from '../../shared/pty-ownership-transfer-source-retirement'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import {
  createOrcadLiveCleanupOutputEvidence,
  listValidatedOrcadLiveCleanupOutputEvidence
} from './orcad-live-cleanup-output-evidence'

export function parseOrcadLiveSourceCancellationReceipt(value: unknown) {
  const parsed = z
    .object({
      version: z.literal(1),
      phase: z.literal('source-cancellation-confirmed'),
      migrationId: z.string().min(1).max(1024),
      retirement: z.unknown(),
      cancellation: z.object({
        canceled: z.literal(true),
        sentEndSu: z.number(),
        creditedEndSu: z.number()
      })
    })
    .parse(value)
  const retirement = parsePtyOwnershipTransferSourceRetirementEvidence(parsed.retirement)
  const { delivery } = retirement.sourceDeliveryRetirement
  if (
    parsed.cancellation.sentEndSu !== delivery.sentEndSu ||
    parsed.cancellation.creditedEndSu !== delivery.creditedEndSu
  ) {
    throw new Error('orcad_live_source_cancellation_boundary_mismatch')
  }
  const {
    version: _version,
    sourceDeliveryRetirement: _retirement,
    sourceCancellation: _cancellation,
    ...identity
  } = retirement
  return { ...parsed, identity, retirement }
}

/** Caller must obtain both confirmations under current migration authority before persisting. */
export function createOrcadLiveSourceCancellationReceipt(options: {
  record: unknown
  settlements: unknown
  retirement: unknown
  cancellation: unknown
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const output = createOrcadLiveCleanupOutputEvidence(record, options.settlements)
  const receipt = parseOrcadLiveSourceCancellationReceipt({
    version: 1,
    phase: 'source-cancellation-confirmed',
    migrationId: record.release.cutover.manifest.migrationId,
    retirement: options.retirement,
    cancellation: options.cancellation
  })
  const { delivery, retirementRecordSha256 } = receipt.retirement.sourceDeliveryRetirement
  const binding = record.release.cutover.liveTerminalBindings!.find(({ identity }) =>
    samePtyOwnershipTransferIdentity(identity, receipt.identity)
  )
  const settled = output.settlements.find((entry) => entry.id === receipt.identity.terminalId)
  if (
    !binding ||
    retirementRecordSha256 !== record.sha256 ||
    !settled ||
    settled.clientGeneration !== delivery.clientGeneration ||
    settled.ownerGeneration !== delivery.ownerGeneration ||
    settled.ptyIncarnation !== delivery.ptyIncarnation ||
    settled.deliveryToken !== delivery.deliveryToken ||
    settled.throughSourceEndSu !== delivery.creditedEndSu
  ) {
    throw new Error('orcad_live_source_cancellation_settlement_mismatch')
  }
  // Local provider generations do not identify the host delivery's provider generation.
  return receipt
}

/** Per-terminal historical receipt; not whole-host completion or permission to discard recovery. */
export class OrcadLiveSourceCancellationReceiptStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveSourceCancellationReceipt>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-source-cancellation-receipts'),
      parseOrcadLiveSourceCancellationReceipt,
      'orcad_live_source_cancellation_receipt'
    )
  }
}

export function listValidatedOrcadLiveSourceCancellationReceipts(
  profileDirectory: string,
  outputs = listValidatedOrcadLiveCleanupOutputEvidence(profileDirectory)
) {
  return new OrcadLiveSourceCancellationReceiptStore(profileDirectory).list().map((receipt) => {
    const matches = outputs.filter(
      ({ record }) =>
        record.sha256 === receipt.retirement.sourceDeliveryRetirement.retirementRecordSha256
    )
    if (matches.length !== 1) {
      throw new Error('orcad_live_source_cancellation_receipt_conflict')
    }
    const { record, evidence } = matches[0]
    const expected = createOrcadLiveSourceCancellationReceipt({
      record,
      settlements: evidence.settlements,
      retirement: receipt.retirement,
      cancellation: receipt.cancellation
    })
    if (serializeOrcadMigrationValue(expected) !== serializeOrcadMigrationValue(receipt)) {
      throw new Error('orcad_live_source_cancellation_receipt_conflict')
    }
    return { record, receipt }
  })
}
