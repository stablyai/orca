import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import type { PtyOwnershipTransferStatusResult } from '../../shared/pty-ownership-transfer-wire'
import {
  outgoingOrcadSourcePreparationRequest,
  type OrcadOutgoingPreparation
} from './orcad-outgoing-preparation-store'

export function assertOutgoingOrcadPreparationStatusBinding(
  intent: OrcadOutgoingPreparation,
  status: Pick<PtyOwnershipTransferStatusResult, 'surfacePublication' | 'destinationDelegation'>
) {
  const expected = outgoingOrcadSourcePreparationRequest(intent)
  if (
    serializeOrcadMigrationValue(status.surfacePublication) !==
    serializeOrcadMigrationValue(expected.surfacePublication)
  ) {
    throw new Error('orcad_outgoing_preparation_surface_unverifiable')
  }
  if (
    serializeOrcadMigrationValue(status.destinationDelegation) !==
    serializeOrcadMigrationValue(expected.destinationDelegation)
  ) {
    throw new Error('orcad_outgoing_preparation_delegation_unverifiable')
  }
}
