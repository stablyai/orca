import { join } from 'node:path'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { parseOrcadPreparationConnection } from './orcad-outgoing-preparation-connection'

function parseDrainReceipt(value: unknown) {
  const connection = parseOrcadPreparationConnection(value)
  const record = value as Record<string, unknown>
  if (record.kind !== 'mux-control-drain' || record.scope !== 'bound-mux-lifetime') {
    throw new Error('orcad_preparation_drain_receipt_invalid')
  }
  return {
    ...connection,
    kind: 'mux-control-drain' as const,
    scope: 'bound-mux-lifetime' as const
  }
}

/** RPC settlement on one mux, not older-connection history, child consumption or host preparation. */
export class OrcadOutgoingPreparationDrainReceiptStore extends OrcadOutgoingEvidenceStore<
  ReturnType<typeof parseDrainReceipt>
> {
  constructor(profileDirectory: string) {
    super(
      join(profileDirectory, 'orcad-outgoing-preparation-drains'),
      parseDrainReceipt,
      'orcad_preparation_drain_receipt'
    )
  }
}
