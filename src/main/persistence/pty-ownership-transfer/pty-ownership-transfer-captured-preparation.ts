import { randomUUID } from 'node:crypto'
import { parsePtyOwnershipCaptureBaseline } from '../../../shared/pty-ownership-capture-baseline'
import { withOrcadDelegatedSource } from '../../orcad/orcad-delegated-source-session'
import { importOrcadDelegatedInitialModel } from '../../orcad/orcad-delegated-initial-model-import'
import { parsePtyOwnershipTransferDelegatedSource } from './pty-ownership-transfer-delegated-source'
import { parsePtyOwnershipInitialModelSnapshot } from './pty-ownership-transfer-initial-model-snapshot'
import { digestPtyOwnershipInitialModelSnapshot } from './pty-ownership-transfer-initial-model-digest'
import { parsePtyOwnershipTransferPrepareResult } from '../../../shared/pty-ownership-transfer-wire-results'
import type {
  PtyOwnershipTransferWireIdentity,
  PtyOwnershipTransferPrepareResult
} from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import type { PtyOwnershipTransferDestinationRuntimeRegistry } from './pty-ownership-transfer-destination-runtime'
import { bindCapturedPtyCatalogAdmission } from './pty-ownership-transfer-captured-catalog-admission'

export type CapturedPtyOwnershipDestinationRequest = {
  identity: PtyOwnershipTransferWireIdentity
  source: unknown
  model: unknown
  selection?: unknown
  catalogAdmission?: unknown
  signal: AbortSignal
  timeoutMs?: number
}

/** Publishes the authenticated historical boundary; later source output stays on the catch-up lane. */
export async function prepareCapturedPtyOwnershipDestination(
  request: CapturedPtyOwnershipDestinationRequest,
  options: {
    runtimeId: string
    destinationStore: PtyOwnershipTransferDestinationFileStore
    catalogStore?: {
      preparePtyOwnershipTransferCatalogAdmission?: Parameters<
        typeof bindCapturedPtyCatalogAdmission
      >[0]['prepareCatalog']
    }
    assertActive?: () => void
    prepare: (
      result: PtyOwnershipTransferPrepareResult,
      source: unknown
    ) => ReturnType<PtyOwnershipTransferDestinationRuntimeRegistry['prepareDelegated']>
  }
) {
  options.assertActive?.()
  const prepareCatalog = options.catalogStore?.preparePtyOwnershipTransferCatalogAdmission?.bind(
    options.catalogStore
  )
  const catalogAdmission =
    request.catalogAdmission === undefined ? undefined : structuredClone(request.catalogAdmission)
  if (catalogAdmission !== undefined && !prepareCatalog) {
    throw new Error('pty_ownership_transfer_captured_catalog_unavailable')
  }
  if (
    catalogAdmission !== undefined &&
    !options.destinationStore.surface.supportsCatalogPublication()
  ) {
    throw new Error('pty_ownership_transfer_catalog_publication_not_supported')
  }
  const source = parsePtyOwnershipTransferDelegatedSource(request.source, request.identity)
  const selection =
    request.selection === undefined
      ? undefined
      : parsePtyOwnershipCaptureBaseline(request.selection, source.proof)
  if (
    selection &&
    digestPtyOwnershipInitialModelSnapshot(
      request.model,
      source.proof,
      selection.boundary.throughSeq
    ) !== selection.modelSha256
  ) {
    throw new Error('pty_ownership_transfer_captured_model_mismatch')
  }
  if (source.proof.destinationRuntimeId !== options.runtimeId) {
    throw new Error('pty_ownership_transfer_captured_runtime_mismatch')
  }
  const requireUnclaimed = () => {
    request.signal.throwIfAborted()
    if (
      options.destinationStore.load(source.proof) &&
      options.destinationStore.loadDelegatedClaimIntent(source.proof)
    ) {
      throw new Error('pty_ownership_transfer_captured_destination_already_claimed')
    }
  }
  requireUnclaimed()
  const preparation = await withOrcadDelegatedSource(
    { source, signal: request.signal, timeoutMs: request.timeoutMs },
    async (client, assertActive) => {
      let status = await client.status(source.proof, {
        signal: request.signal,
        timeoutMs: request.timeoutMs
      })
      assertActive()
      requireUnclaimed()
      if (
        !status.captureBaseline &&
        selection &&
        status.phase === 'prepared' &&
        status.destinationClaim === null &&
        status.captureImportAckVersion === 1 &&
        status.surfacePublication?.surfaceBinding.executionHostId === 'local'
      ) {
        await client.recoverCaptureSelection(source.proof, selection, {
          signal: request.signal,
          timeoutMs: request.timeoutMs
        })
        assertActive()
        requireUnclaimed()
        status = await client.status(source.proof, {
          signal: request.signal,
          timeoutMs: request.timeoutMs
        })
        assertActive()
        requireUnclaimed()
      }
      if (
        status.phase !== 'prepared' ||
        status.destinationClaim !== null ||
        !status.captureBaseline ||
        (selection && JSON.stringify(status.captureBaseline) !== JSON.stringify(selection)) ||
        status.surfacePublication?.surfaceBinding.executionHostId !== 'local' ||
        status.captureImportAckVersion !== 1
      ) {
        throw new Error('pty_ownership_transfer_captured_source_unavailable')
      }
      const throughSeq = status.captureBaseline.boundary.throughSeq
      const model = parsePtyOwnershipInitialModelSnapshot(request.model, source.proof, throughSeq)
      if (
        digestPtyOwnershipInitialModelSnapshot(model, source.proof, throughSeq) !==
        status.captureBaseline.modelSha256
      ) {
        throw new Error('pty_ownership_transfer_captured_model_mismatch')
      }
      return {
        model,
        result: parsePtyOwnershipTransferPrepareResult({
          ...source.proof,
          version: 1,
          phase: 'prepared',
          sourceOutputEndSeq: throughSeq,
          replayStartSeq: throughSeq + 1,
          surfacePublication: status.surfacePublication
        })
      }
    }
  )
  requireUnclaimed()
  if (catalogAdmission !== undefined) {
    bindCapturedPtyCatalogAdmission({
      value: catalogAdmission,
      result: preparation.result,
      source,
      destinationStore: options.destinationStore,
      prepareCatalog: prepareCatalog!,
      assertActive: () => {
        requireUnclaimed()
        options.assertActive?.()
      }
    })
  }
  const prepared = options.prepare(preparation.result, source)
  const imported = await importOrcadDelegatedInitialModel({
    runtimeId: options.runtimeId,
    identity: source.proof,
    model: preparation.model,
    store: options.destinationStore,
    outbox: prepared.outputOutbox,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    requirePreparedUnclaimedSource: true
  })
  requireUnclaimed()
  const receipt = options.destinationStore.load(source.proof)?.receipt ?? {
    bridgeId: source.proof.bridgeId,
    receiptId: randomUUID(),
    acceptedSourceEndSeq: imported.throughSeq,
    committedAt: new Date().toISOString()
  }
  prepared.adapter.commit(receipt)
  const publicationReceipt = prepared.adapter.publish()
  return {
    ...prepared,
    snapshot: prepared.adapter.snapshot(),
    importReceipt: imported,
    publicationReceipt
  }
}
