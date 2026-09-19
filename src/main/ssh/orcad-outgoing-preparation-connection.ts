import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import type { OrcadOutgoingPreparation } from './orcad-outgoing-preparation-store'

const connections = new WeakMap<object, string>()

export function parseOrcadPreparationConnection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('orcad_preparation_connection_invalid')
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.connectionId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.connectionId) ||
    typeof record.preparationSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.preparationSha256) ||
    !Number.isSafeInteger(record.providerGeneration) ||
    Number(record.providerGeneration) <= 0
  ) {
    throw new Error('orcad_preparation_connection_invalid')
  }
  return {
    version: 1 as const,
    identity: parsePtyOwnershipTransferWireIdentity(record.identity),
    connectionId: record.connectionId,
    preparationSha256: record.preparationSha256,
    providerGeneration: Number(record.providerGeneration)
  }
}

/** A connection binding is uncertainty evidence, never proof of host application or drain. */
export class OrcadOutgoingPreparationConnectionStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseOrcadPreparationConnection>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-outgoing-preparation-connections'),
      parseOrcadPreparationConnection,
      'orcad_preparation_connection'
    )
  }

  pin(
    intent: OrcadOutgoingPreparation,
    source: { provider: object; providerGeneration: number },
    existingIntent: boolean
  ): void {
    const before = this.read(intent.identity)
    if (existingIntent && !before) {
      throw new Error('orcad_preparation_connection_reconciliation_required')
    }
    let connectionId = connections.get(source.provider)
    if (!connectionId) {
      connectionId = randomUUID()
      connections.set(source.provider, connectionId)
    }
    const record = parseOrcadPreparationConnection({
      version: 1,
      identity: intent.identity,
      connectionId,
      providerGeneration: source.providerGeneration,
      preparationSha256: createHash('sha256')
        .update(serializeOrcadMigrationValue(intent))
        .digest('hex')
    })
    if (before && serializeOrcadMigrationValue(before) !== serializeOrcadMigrationValue(record)) {
      throw new Error('orcad_preparation_connection_reconciliation_required')
    }
    this.persist(record)
  }

  assertPinned(
    intent: OrcadOutgoingPreparation,
    source: { provider: object; providerGeneration: number }
  ) {
    const saved = this.read(intent.identity)
    if (
      !saved ||
      saved.connectionId !== connections.get(source.provider) ||
      saved.providerGeneration !== source.providerGeneration ||
      saved.preparationSha256 !==
        createHash('sha256').update(serializeOrcadMigrationValue(intent)).digest('hex')
    ) {
      throw new Error('orcad_preparation_connection_reconciliation_required')
    }
    return saved
  }
}
