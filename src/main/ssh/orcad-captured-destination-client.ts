import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  PTY_CAPTURED_DESTINATION_PREPARE_METHOD,
  PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD
} from '../../shared/pty-ownership-transfer-runtime-methods'
import { parseOrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipCaptureImportReceipt } from '../../shared/pty-ownership-capture-import-receipt'
import { parsePtyOwnershipTransferPublicationReceipt } from '../../shared/pty-ownership-transfer-receipt-wire'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from '../../shared/pty-ownership-transfer-surface-binding'
import { parsePtyOwnershipTransferDelegatedSource } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-delegated-source'
import { parsePtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-snapshot'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import type { CapturedPtyOwnershipDestinationRequest } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-captured-preparation'

export async function prepareRemoteOrcadCapturedDestination(options: {
  pairingCode: string
  runtimeId: string
  capture: CapturedPtyOwnershipDestinationRequest
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
}) {
  const pairing = parsePairingCode(options.pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const { capture } = options
  capture.signal.throwIfAborted()
  const catalog =
    capture.catalogAdmission === undefined
      ? undefined
      : parseOrcadTerminalLayoutAdmission(capture.catalogAdmission)
  const identity = parsePtyOwnershipTransferWireIdentity(capture.identity)
  if (!options.runtimeId.trim() || identity.destinationRuntimeId !== options.runtimeId) {
    throw new Error('orcad_captured_destination_runtime_mismatch')
  }
  const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(options.surfaceBinding)
  if (surfaceBinding.executionHostId !== 'local' || surfaceBinding.ptyId !== identity.terminalId) {
    throw new Error('orcad_captured_destination_surface_mismatch')
  }
  if (
    catalog &&
    !catalog.bindings.some(
      (entry) =>
        samePtyOwnershipTransferIdentity(entry.identity, identity) &&
        samePtyOwnershipTransferSurfaceBinding(entry.surfaceBinding, surfaceBinding)
    )
  ) {
    throw new Error('orcad_captured_destination_catalog_identity_mismatch')
  }
  const source = parsePtyOwnershipTransferDelegatedSource(capture.source, identity)
  const model = parsePtyOwnershipInitialModelSnapshot(
    capture.model,
    identity,
    Number((capture.model as Record<string, unknown> | null)?.throughSeq)
  )
  const digest = digestPtyOwnershipInitialModelSnapshot(model, identity, model.throughSeq)
  const timeoutMs = capture.timeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('orcad_captured_destination_timeout_invalid')
  }
  if (catalog) {
    const probe = await sendRemoteRuntimeRequest<unknown>(
      pairing,
      PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD,
      { version: 1 },
      timeoutMs,
      undefined,
      capture.signal,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    capture.signal.throwIfAborted()
    const support = probe.ok ? (probe.result as Record<string, unknown> | null) : null
    if (
      !probe.ok ||
      probe._meta.runtimeId !== identity.destinationRuntimeId ||
      support?.version !== 1 ||
      support.catalogPublication !== 1
    ) {
      throw new Error('orcad_captured_destination_catalog_negotiation_required')
    }
  }
  const response = await sendRemoteRuntimeRequest<unknown>(
    pairing,
    PTY_CAPTURED_DESTINATION_PREPARE_METHOD,
    {
      version: catalog ? 2 : 1,
      ...(catalog ? { catalogAdmission: catalog } : {}),
      identity,
      source,
      model,
      timeoutMs,
      ...(capture.selection === undefined ? {} : { selection: capture.selection })
    },
    timeoutMs,
    undefined,
    capture.signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  capture.signal.throwIfAborted()
  if (!response.ok) {
    throw new Error(`orcad_captured_destination_failed:${response.error.code}`)
  }
  if (response._meta.runtimeId !== identity.destinationRuntimeId) {
    throw new Error('orcad_captured_destination_runtime_mismatch')
  }
  const result = response.result as Record<string, unknown> | null
  if (
    !result ||
    result.version !== (catalog ? 2 : 1) ||
    result.outcome !== 'published' ||
    !samePtyOwnershipTransferIdentity(
      parsePtyOwnershipTransferWireIdentity(result.identity),
      identity
    )
  ) {
    throw new Error('orcad_captured_destination_reply_invalid')
  }
  const catalogReceipt = result.catalog as Record<string, unknown> | null
  if (
    catalog &&
    (catalogReceipt?.migrationId !== catalog.manifest.migrationId ||
      catalogReceipt?.manifestSha256 !== catalog.manifest.manifestSha256)
  ) {
    throw new Error('orcad_captured_destination_catalog_receipt_mismatch')
  }
  const importReceipt = parsePtyOwnershipCaptureImportReceipt(result.importReceipt, identity)
  const publicationReceipt = parsePtyOwnershipTransferPublicationReceipt(result.publicationReceipt)
  if (
    importReceipt.throughSeq !== model.throughSeq ||
    importReceipt.modelSha256 !== digest ||
    publicationReceipt.bridgeId !== identity.bridgeId ||
    publicationReceipt.destinationRuntimeId !== identity.destinationRuntimeId ||
    publicationReceipt.commitReceipt.bridgeId !== identity.bridgeId ||
    publicationReceipt.commitReceipt.acceptedSourceEndSeq !== model.throughSeq ||
    !samePtyOwnershipTransferSurfaceBinding(publicationReceipt.surfaceBinding, surfaceBinding)
  ) {
    throw new Error('orcad_captured_destination_receipt_mismatch')
  }
  return {
    version: 1 as const,
    outcome: 'published' as const,
    identity,
    importReceipt,
    publicationReceipt
  }
}
