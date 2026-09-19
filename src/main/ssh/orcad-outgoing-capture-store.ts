import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import { join } from 'node:path'
import { z } from 'zod'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipCaptureBaseline } from '../../shared/pty-ownership-capture-baseline'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { parsePtyOwnershipTransferDelegatedSource } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-delegated-source'
import { parsePtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-snapshot'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import { parseOrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { samePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'

const metadata = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  destinationEnvironmentId: z.string().min(1).max(1024),
  sourceSshTargetId: z.string().min(1).max(1024),
  sourceSshTargetGeneration: z.number().int().positive().safe()
})

export function parseOrcadOutgoingTargetBinding(value: unknown) {
  const header = metadata.parse(value)
  const raw = value as Record<string, unknown>
  const identity = parsePtyOwnershipTransferWireIdentity(raw.identity)
  if (header.version === 1 && raw.catalogAdmission !== undefined) {
    throw new Error('orcad_outgoing_catalog_version_required')
  }
  const catalogAdmission =
    header.version === 2 ? parseOrcadTerminalLayoutAdmission(raw.catalogAdmission) : undefined
  if (
    catalogAdmission &&
    (catalogAdmission.manifest.source.sshTargetId !== header.sourceSshTargetId ||
      catalogAdmission.manifest.source.sshTargetGeneration !== header.sourceSshTargetGeneration)
  ) {
    throw new Error('orcad_outgoing_catalog_source_mismatch')
  }
  return { ...header, identity, ...(catalogAdmission ? { catalogAdmission } : {}) }
}

export function parseOrcadOutgoingSourceBinding(value: unknown) {
  const header = parseOrcadOutgoingTargetBinding(value)
  const { identity } = header
  const raw = value as Record<string, unknown>
  const source = parsePtyOwnershipTransferDelegatedSource(raw.source, identity)
  const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(raw.surfaceBinding)
  if (surfaceBinding.executionHostId !== 'local' || surfaceBinding.ptyId !== identity.terminalId) {
    throw new Error('orcad_outgoing_capture_evidence_mismatch')
  }
  if (
    header.catalogAdmission &&
    !header.catalogAdmission.bindings.some(
      (entry) =>
        samePtyOwnershipTransferIdentity(entry.identity, identity) &&
        samePtyOwnershipTransferSurfaceBinding(entry.surfaceBinding, surfaceBinding)
    )
  ) {
    throw new Error('orcad_outgoing_catalog_identity_mismatch')
  }
  return { ...header, identity, source, surfaceBinding }
}

export function parseOrcadOutgoingCapture(value: unknown) {
  const binding = parseOrcadOutgoingSourceBinding(value)
  const { identity } = binding
  const raw = value as Record<string, unknown>
  const selection = parsePtyOwnershipCaptureBaseline(raw.selection, identity)
  const model = parsePtyOwnershipInitialModelSnapshot(
    raw.model,
    identity,
    selection.boundary.throughSeq
  )
  if (
    digestPtyOwnershipInitialModelSnapshot(model, identity, model.throughSeq) !==
    selection.modelSha256
  ) {
    throw new Error('orcad_outgoing_capture_evidence_mismatch')
  }
  return { ...binding, selection, model }
}

export type OrcadOutgoingCapture = ReturnType<typeof parseOrcadOutgoingCapture>

export class OrcadOutgoingCaptureStore extends OrcadOutgoingEvidenceStore<OrcadOutgoingCapture> {
  constructor(profileDirectory: string) {
    super(join(profileDirectory, 'orcad-outgoing-captures'), parseOrcadOutgoingCapture)
  }
}
