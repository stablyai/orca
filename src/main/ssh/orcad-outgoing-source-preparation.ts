import { bindOutgoingOrcadSource } from './orcad-outgoing-source-binding'
import {
  outgoingOrcadSourcePreparationRequest,
  parseOrcadOutgoingPreparation,
  type OrcadOutgoingPreparationStore
} from './orcad-outgoing-preparation-store'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferPrepareResult } from '../../shared/pty-ownership-transfer-wire-results'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { recoverOutgoingOrcadPreparationDurability } from './orcad-outgoing-preparation-durability'

/** Caller holds lifecycle authority; errors preserve intent and never imply source rollback. */
export async function prepareOutgoingOrcadSource(options: {
  store: OrcadOutgoingPreparationStore
  preparation: unknown
  ptyId: string
  signal: AbortSignal
  assertAuthority: () => void
  recoverDurability?: boolean
}) {
  const intent = parseOrcadOutgoingPreparation(options.preparation)
  const source = bindOutgoingOrcadSource({
    ...options,
    identity: intent.identity,
    sourceSshTargetId: intent.sourceSshTargetId
  })
  const capabilities = await source.provider.getOwnershipBridgeCapabilities?.({
    signal: options.signal
  })
  source.assertSource()
  if (
    !capabilities?.liveTransfer ||
    capabilities.preparationShutdownGuardVersion !== 1 ||
    capabilities.transferGraceGuardVersion !== 1 ||
    capabilities.transferLifecycleGuardVersion !== 1 ||
    capabilities.destinationDelegationVersion !== 1 ||
    capabilities.captureBoundaryVersion !== 1 ||
    capabilities.captureSelectionVersion !== 1 ||
    !source.provider.drainOutgoingSourceControls
  ) {
    throw new Error('orcad_outgoing_preparation_unsupported')
  }
  const saved = options.store.persistForSource(intent, source)
  const request = outgoingOrcadSourcePreparationRequest(saved)
  await source.provider.drainOutgoingSourceControls({
    identity: saved.identity,
    surfaceBinding: saved.surfaceBinding,
    providerGeneration: source.providerGeneration,
    signal: options.signal
  })
  source.assertSource()
  options.store.persistSourceDrain(saved, source)
  source.assertSource()
  const assertCurrent = () => {
    source.assertSource()
    options.store.assertSourceConnection(saved, source)
    if (
      serializeOrcadMigrationValue(options.store.read(saved.identity)) !==
      serializeOrcadMigrationValue(saved)
    ) {
      throw new Error('orcad_outgoing_preparation_evidence_changed')
    }
  }
  const prepare = () => {
    assertCurrent()
    return source.request(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, {
      signal: options.signal,
      timeoutMs: 5_000
    })
  }
  let reply: unknown
  try {
    reply = await prepare()
  } catch (error) {
    if (
      !options.recoverDurability ||
      !capabilities.statusQuery ||
      !(error instanceof Error) ||
      error.message !== 'pty_ownership_transfer_delegation_write_unverifiable'
    ) {
      throw error
    }
    await recoverOutgoingOrcadPreparationDurability({
      intent: saved,
      signal: options.signal,
      request: (method, params, requestOptions) =>
        source.request(method, params as Record<string, unknown>, requestOptions),
      assertCurrent
    })
    reply = await prepare()
  }
  source.assertSource()
  options.store.assertSourceConnection(saved, source)
  const prepared = parsePtyOwnershipTransferPrepareResult(reply)
  if (
    !samePtyOwnershipTransferIdentity(prepared, saved.identity) ||
    serializeOrcadMigrationValue(prepared.destinationDelegation) !==
      serializeOrcadMigrationValue(request.destinationDelegation) ||
    serializeOrcadMigrationValue(prepared.surfacePublication) !==
      serializeOrcadMigrationValue(request.surfacePublication) ||
    serializeOrcadMigrationValue(options.store.read(saved.identity)) !==
      serializeOrcadMigrationValue(saved)
  ) {
    throw new Error('orcad_outgoing_preparation_reply_unverifiable')
  }
  return { intent: saved, prepared }
}
