import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipCaptureImportReceipt } from '../../shared/pty-ownership-capture-import-receipt'
import type { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import type { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import { parsePtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-snapshot'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import { withOrcadDelegatedSource } from './orcad-delegated-source-session'

/** Verifies through the registered source endpoint; never trusts a caller-supplied selection. */
export async function importOrcadDelegatedInitialModel(options: {
  runtimeId: string
  identity: PtyOwnershipTransferWireIdentity
  model: unknown
  store: PtyOwnershipTransferDestinationFileStore
  outbox: PtyOwnershipTransferDestinationOutputOutbox
  signal: AbortSignal
  timeoutMs?: number
  requirePreparedUnclaimedSource?: boolean
}) {
  const identity = parsePtyOwnershipTransferWireIdentity(options.identity)
  const source = options.store.loadDelegatedSource(identity)
  const output = options.outbox.load(identity)
  if (!source || !output || identity.destinationRuntimeId !== options.runtimeId) {
    throw new Error('orcad_delegated_initial_model_destination_unavailable')
  }
  const model = parsePtyOwnershipInitialModelSnapshot(options.model, identity, output.baseEndSeq)
  const digest = digestPtyOwnershipInitialModelSnapshot(model, identity, output.baseEndSeq)
  const sourceKey = serializeOrcadMigrationValue(source)
  const surfaceKey = serializeOrcadMigrationValue(options.store.loadSurfaceBinding(identity))
  const requireDestination = () => {
    options.signal.throwIfAborted()
    const journal = options.store.load(identity)
    const binding = options.store.loadSurfaceBinding(identity)
    const current = options.outbox.load(identity)
    if (
      !journal ||
      journal.phase === 'aborted' ||
      binding?.executionHostId !== 'local' ||
      serializeOrcadMigrationValue(binding) !== surfaceKey ||
      current?.baseEndSeq !== model.throughSeq ||
      serializeOrcadMigrationValue(options.store.loadDelegatedSource(identity)) !== sourceKey
    ) {
      throw new Error('orcad_delegated_initial_model_destination_changed')
    }
    const existing = options.outbox.loadInitialModelSnapshot(identity)
    if (
      existing &&
      digestPtyOwnershipInitialModelSnapshot(existing, identity, model.throughSeq) !== digest
    ) {
      throw new Error('orcad_delegated_initial_model_import_conflict')
    }
    if (
      !existing &&
      (journal.phase !== 'prepared' || journal.acceptedSourceEndSeq !== model.throughSeq)
    ) {
      throw new Error('orcad_delegated_initial_model_import_too_late')
    }
  }
  requireDestination()
  return withOrcadDelegatedSource(
    { source, signal: options.signal, timeoutMs: options.timeoutMs },
    async (client, assertActive) => {
      const inspect = async () => {
        requireDestination()
        const status = await client.status(source.proof, {
          signal: options.signal,
          timeoutMs: options.timeoutMs
        })
        assertActive()
        requireDestination()
        if (
          options.requirePreparedUnclaimedSource &&
          (status.phase !== 'prepared' ||
            status.destinationClaim !== null ||
            status.captureImportAckVersion !== 1 ||
            serializeOrcadMigrationValue(status.surfacePublication?.surfaceBinding) !==
              surfaceKey ||
            options.store.loadDelegatedClaimIntent(identity))
        ) {
          throw new Error('orcad_delegated_initial_model_source_no_longer_preparable')
        }
        if (
          status.phase === 'aborted' ||
          !status.captureBaseline ||
          status.captureBaseline.boundary.throughSeq !== model.throughSeq ||
          status.captureBaseline.modelSha256 !== digest
        ) {
          throw new Error('orcad_delegated_initial_model_source_mismatch')
        }
        return status.captureBaseline
      }
      const before = await inspect()
      options.outbox.recordInitialModelSnapshot(identity, model)
      const persisted = options.outbox.loadInitialModelSnapshot(identity)
      if (
        !persisted ||
        digestPtyOwnershipInitialModelSnapshot(persisted, identity, model.throughSeq) !== digest
      ) {
        throw new Error('orcad_delegated_initial_model_import_unverified')
      }
      const after = await inspect()
      if (serializeOrcadMigrationValue(before) !== serializeOrcadMigrationValue(after)) {
        throw new Error('orcad_delegated_initial_model_source_changed')
      }
      return parsePtyOwnershipCaptureImportReceipt(
        { version: 1, identity, throughSeq: model.throughSeq, modelSha256: digest },
        identity
      )
    }
  )
}
