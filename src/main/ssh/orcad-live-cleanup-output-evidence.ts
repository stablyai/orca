import { join } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  assertNonNegativeSafeInteger,
  assertPtySourceIdentity
} from '../../shared/pty-source-credit-validation'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { parseOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import {
  createOrcadLiveSourceCleanupIntent,
  parseOrcadLiveSourceCleanupIntent,
  listValidatedOrcadLiveCleanupPreparations
} from './orcad-live-source-cleanup-intent'

const settlementSchema = z.object({
  id: z.string(),
  providerGeneration: z.number(),
  clientGeneration: z.number(),
  ownerGeneration: z.number(),
  ptyIncarnation: z.string(),
  deliveryToken: z.string(),
  fromSourceEndSu: z.number(),
  throughSourceEndSu: z.number()
})

export function parseOrcadLiveSourceOutputSettlement(value: unknown) {
  const settlement = settlementSchema.parse(value)
  assertPtySourceIdentity(settlement)
  assertNonNegativeSafeInteger(settlement.fromSourceEndSu, 'fromSourceEndSu')
  assertNonNegativeSafeInteger(settlement.throughSourceEndSu, 'throughSourceEndSu')
  if (settlement.fromSourceEndSu > settlement.throughSourceEndSu) {
    throw new Error('orcad_live_cleanup_output_settlement_invalid')
  }
  return settlement
}

export function parseOrcadLiveCleanupOutputEvidence(value: unknown) {
  const parsed = z
    .object({
      phase: z.literal('source-output-settled'),
      settlements: z.array(settlementSchema).min(1)
    })
    .passthrough()
    .parse(value)
  const ids = new Set<string>()
  for (const settlement of parsed.settlements) {
    parseOrcadLiveSourceOutputSettlement(settlement)
    if (ids.has(settlement.id)) {
      throw new Error('orcad_live_cleanup_output_settlement_invalid')
    }
    ids.add(settlement.id)
  }
  return {
    ...parseOrcadLiveSourceCleanupIntent({ ...parsed, phase: 'cleanup-prepared' }),
    phase: 'source-output-settled' as const,
    settlements: parsed.settlements
  }
}

export function createOrcadLiveCleanupOutputEvidence(recordValue: unknown, settlements: unknown) {
  const record = parseOrcadLiveSourceRetirementRecord(recordValue)
  const evidence = parseOrcadLiveCleanupOutputEvidence({
    ...createOrcadLiveSourceCleanupIntent(record),
    phase: 'source-output-settled',
    settlements
  })
  const bindings = record.release.cutover.liveTerminalBindings!
  const byId = new Map(evidence.settlements.map((entry) => [entry.id, entry]))
  if (
    byId.size !== bindings.length ||
    bindings.some(({ identity }) => {
      const settled = byId.get(identity.terminalId)
      return (
        !settled ||
        settled.ptyIncarnation !== identity.incarnationId ||
        settled.ownerGeneration !== identity.sourceOwnerGeneration
      )
    })
  ) {
    throw new Error('orcad_live_cleanup_output_cohort_mismatch')
  }
  return {
    ...evidence,
    settlements: bindings.map(({ identity }) => byId.get(identity.terminalId)!)
  }
}

/** Historical local settlement ranges, not transcript storage, host ACK receipts or fresh ownership. */
export class OrcadLiveCleanupOutputEvidenceStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadLiveCleanupOutputEvidence>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-live-cleanup-output-evidence'),
      parseOrcadLiveCleanupOutputEvidence,
      'orcad_live_cleanup_output_evidence'
    )
  }
}

export function listValidatedOrcadLiveCleanupOutputEvidence(
  profileDirectory: string,
  preparations = listValidatedOrcadLiveCleanupPreparations(profileDirectory)
) {
  return new OrcadLiveCleanupOutputEvidenceStore(profileDirectory).list().map((evidence) => {
    const matches = preparations.filter(
      ({ record }) => record.sha256 === evidence.retirementRecordSha256
    )
    if (
      matches.length !== 1 ||
      serializeOrcadMigrationValue(evidence) !==
        serializeOrcadMigrationValue(
          createOrcadLiveCleanupOutputEvidence(matches[0].record, evidence.settlements)
        )
    ) {
      throw new Error('orcad_live_cleanup_output_evidence_conflict')
    }
    return { evidence, record: matches[0].record }
  })
}
