import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parsePtyOwnershipTransferPrepareRequest } from '../../shared/pty-ownership-transfer-wire'
import { parseOrcadOutgoingSourceBinding } from './orcad-outgoing-capture-store'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { OrcadOutgoingPreparationConnectionStore } from './orcad-outgoing-preparation-connection'
import { OrcadOutgoingPreparationDrainReceiptStore } from './orcad-outgoing-preparation-drain-receipt'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'

export function parseOrcadOutgoingPreparation(value: unknown) {
  const binding = parseOrcadOutgoingSourceBinding(value)
  if ((value as Record<string, unknown>).kind !== 'preparation') {
    throw new Error('orcad_outgoing_preparation_kind_invalid')
  }
  return { ...binding, kind: 'preparation' as const }
}

export type OrcadOutgoingPreparation = ReturnType<typeof parseOrcadOutgoingPreparation>

/** Persist before source prepare: a lost response must not lose the source's delegation credential. */
export class OrcadOutgoingPreparationStore extends OrcadOutgoingEvidenceStore<OrcadOutgoingPreparation> {
  private readonly connections: OrcadOutgoingPreparationConnectionStore
  private readonly drains: OrcadOutgoingPreparationDrainReceiptStore
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-outgoing-preparations'),
      parseOrcadOutgoingPreparation,
      'orcad_outgoing_preparation'
    )
    this.connections = new OrcadOutgoingPreparationConnectionStore(profileDirectory)
    this.drains = new OrcadOutgoingPreparationDrainReceiptStore(profileDirectory)
  }

  persistForSource(value: unknown, source: { provider: object; providerGeneration: number }) {
    const intent = parseOrcadOutgoingPreparation(value)
    const before = this.read(intent.identity)
    if (before && serializeOrcadMigrationValue(before) !== serializeOrcadMigrationValue(intent)) {
      throw new Error('orcad_outgoing_preparation_conflict')
    }
    this.connections.pin(intent, source, before !== null)
    return this.persist(intent)
  }

  assertSourceConnection(value: unknown, source: { provider: object; providerGeneration: number }) {
    this.connections.assertPinned(parseOrcadOutgoingPreparation(value), source)
  }

  /** Call only after the pinned source's fence-and-drain resolves. */
  persistSourceDrain(value: unknown, source: { provider: object; providerGeneration: number }) {
    const intent = parseOrcadOutgoingPreparation(value)
    const connection = this.connections.assertPinned(intent, source)
    if (
      serializeOrcadMigrationValue(this.read(intent.identity)) !==
      serializeOrcadMigrationValue(intent)
    ) {
      throw new Error('orcad_outgoing_preparation_evidence_changed')
    }
    return this.drains.persist({
      ...connection,
      kind: 'mux-control-drain',
      scope: 'bound-mux-lifetime'
    })
  }
}

export function outgoingOrcadSourcePreparationRequest(value: OrcadOutgoingPreparation) {
  const saved = parseOrcadOutgoingPreparation(value)
  return parsePtyOwnershipTransferPrepareRequest({
    version: 1,
    ...saved.identity,
    destinationDelegation: {
      version: 1,
      credentialSha256: createHash('sha256').update(saved.source.proof.credential).digest('hex')
    },
    surfacePublication: { version: 1, surfaceBinding: saved.surfaceBinding }
  })
}
