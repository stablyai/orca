import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { PtyOwnershipTransferRequestClient } from '../providers/ssh-pty-ownership-transfer-client'
import type { PtyOwnershipTransferRequestTransport } from '../providers/ssh-pty-ownership-transfer-client'
import { OrcadDelegatedTransferClient } from '../orcad/orcad-delegated-transfer-client'
import {
  outgoingOrcadSourcePreparationRequest,
  type OrcadOutgoingPreparation
} from './orcad-outgoing-preparation-store'
import { assertOutgoingOrcadPreparationStatusBinding } from './orcad-outgoing-preparation-status-binding'

/** Explicit same-connection repair; never rebinds source authority or reopens legacy controls. */
export async function recoverOutgoingOrcadPreparationDurability(options: {
  intent: OrcadOutgoingPreparation
  request: PtyOwnershipTransferRequestTransport
  signal: AbortSignal
  assertCurrent: () => void
}) {
  const request: PtyOwnershipTransferRequestTransport = async (method, params, requestOptions) => {
    options.assertCurrent()
    const result = await options.request(method, params, requestOptions)
    options.assertCurrent()
    return result
  }
  const requestOptions = { signal: options.signal, timeoutMs: 5_000 }
  const status = await new PtyOwnershipTransferRequestClient(request).status(
    { version: 1, ...options.intent.identity },
    requestOptions
  )
  const expected = outgoingOrcadSourcePreparationRequest(options.intent)
  assertOutgoingOrcadPreparationStatusBinding(options.intent, status)
  if (status.phase !== 'prepared') {
    throw new Error('orcad_outgoing_preparation_durability_conflict')
  }
  const recovered = await new OrcadDelegatedTransferClient(request).recover(
    options.intent.source.proof,
    requestOptions
  )
  if (
    recovered.phase !== 'prepared' ||
    recovered.destinationClaim !== null ||
    recovered.boundToConnection ||
    recovered.captureBaseline ||
    serializeOrcadMigrationValue(recovered.surfacePublication) !==
      serializeOrcadMigrationValue(expected.surfacePublication)
  ) {
    throw new Error('orcad_outgoing_preparation_durability_conflict')
  }
}
