import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { prepareRemoteOrcadCapturedDestination } from './orcad-captured-destination-client'
import type { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'

/** Caller holds target lifecycle authority; publication does not complete source ownership transfer. */
export async function publishOutgoingOrcadCapture(options: {
  store: OrcadOutgoingCaptureStore
  identity: PtyOwnershipTransferWireIdentity
  destinationEnvironmentId: string
  sourceSshTargetId: string
  sourceSshTargetGeneration: number
  pairingCode: string
  signal: AbortSignal
  assertAuthority: () => void
}) {
  options.signal.throwIfAborted()
  options.assertAuthority()
  const saved = options.store.read(options.identity)
  if (!saved) {
    throw new Error('orcad_outgoing_capture_missing')
  }
  if (
    saved.destinationEnvironmentId !== options.destinationEnvironmentId ||
    saved.sourceSshTargetId !== options.sourceSshTargetId ||
    saved.sourceSshTargetGeneration !== options.sourceSshTargetGeneration
  ) {
    throw new Error('orcad_outgoing_capture_authority_mismatch')
  }
  // A prior uncertain write must become durable before any destination mutation.
  options.store.persist(saved)
  options.signal.throwIfAborted()
  options.assertAuthority()
  const result = await prepareRemoteOrcadCapturedDestination({
    pairingCode: options.pairingCode,
    runtimeId: saved.identity.destinationRuntimeId,
    surfaceBinding: saved.surfaceBinding,
    capture: {
      identity: saved.identity,
      source: saved.source,
      model: saved.model,
      selection: saved.selection,
      ...(saved.catalogAdmission ? { catalogAdmission: saved.catalogAdmission } : {}),
      signal: options.signal
    }
  })
  options.signal.throwIfAborted()
  options.assertAuthority()
  if (
    serializeOrcadMigrationValue(options.store.read(saved.identity)) !==
    serializeOrcadMigrationValue(saved)
  ) {
    throw new Error('orcad_outgoing_capture_changed')
  }
  return result
}
