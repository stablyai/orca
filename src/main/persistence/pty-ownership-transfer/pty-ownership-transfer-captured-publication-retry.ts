import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { parsePtyOwnershipCaptureImportReceipt } from '../../../shared/pty-ownership-capture-import-receipt'
import { parsePtyOwnershipTransferDelegatedSource } from './pty-ownership-transfer-delegated-source'
import { digestPtyOwnershipInitialModelSnapshot } from './pty-ownership-transfer-initial-model-digest'
import type { CapturedPtyOwnershipDestinationRequest } from './pty-ownership-transfer-captured-preparation'
import type { readPublishedDelegatedPtyDestination } from './pty-ownership-transfer-runtime-recovery'
import { parseOrcadTerminalLayoutAdmission } from '../migrating-orcad-catalog/orcad-terminal-layout-admission'

export function readCapturedPtyPublicationRetry(
  request: CapturedPtyOwnershipDestinationRequest,
  destination: ReturnType<typeof readPublishedDelegatedPtyDestination>
) {
  request.signal.throwIfAborted()
  const { adapter, store, outbox } = destination
  const snapshot = adapter.snapshot()
  const journal = store.load(request.identity)
  const source = parsePtyOwnershipTransferDelegatedSource(request.source, request.identity)
  const model = outbox.loadInitialModelSnapshot(request.identity)
  if (
    !journal ||
    journal.phase !== 'published' ||
    !journal.publicationReceipt ||
    !journal.receipt ||
    !model ||
    serializeOrcadMigrationValue(store.loadDelegatedSource(request.identity)) !==
      serializeOrcadMigrationValue(source) ||
    serializeOrcadMigrationValue(snapshot.commitReceipt) !==
      serializeOrcadMigrationValue(journal.receipt) ||
    serializeOrcadMigrationValue(snapshot.publicationReceipt) !==
      serializeOrcadMigrationValue(journal.publicationReceipt) ||
    journal.receipt.acceptedSourceEndSeq !== model.throughSeq
  ) {
    throw new Error('pty_ownership_transfer_captured_retry_unverifiable')
  }
  assertCapturedPtyRetryCatalog(
    request.catalogAdmission,
    store.surface.loadCatalogAdmission(request.identity)
  )
  const digest = digestPtyOwnershipInitialModelSnapshot(model, request.identity, model.throughSeq)
  if (
    digestPtyOwnershipInitialModelSnapshot(request.model, request.identity, model.throughSeq) !==
    digest
  ) {
    throw new Error('pty_ownership_transfer_captured_retry_model_conflict')
  }
  return {
    adapter,
    snapshot,
    outputOutbox: outbox,
    publicationReceipt: journal.publicationReceipt,
    importReceipt: parsePtyOwnershipCaptureImportReceipt(
      {
        version: 1,
        identity: request.identity,
        throughSeq: model.throughSeq,
        modelSha256: digest
      },
      request.identity
    )
  }
}

export function assertCapturedPtyRetryCatalog(requested: unknown, persisted: unknown): void {
  const admitted = persisted == null ? null : parseOrcadTerminalLayoutAdmission(persisted)
  const proposal = requested === undefined ? null : parseOrcadTerminalLayoutAdmission(requested)
  if (serializeOrcadMigrationValue(admitted) !== serializeOrcadMigrationValue(proposal)) {
    throw new Error('pty_ownership_transfer_captured_retry_catalog_conflict')
  }
}
