import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { OrcadOutgoingCaptureStore } from './orcad-outgoing-capture-store'
import { publishOutgoingOrcadCapture } from './orcad-outgoing-capture-publication'
import { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'

export async function recoverOutgoingOrcadCapture(
  userDataPath: string,
  args: { identity: PtyOwnershipTransferWireIdentity; signal: AbortSignal }
) {
  if (!isPtyOwnershipTransferMutationEnabled()) {
    throw new Error('pty_ownership_transfer_mutation_disabled')
  }
  args.signal.throwIfAborted()
  const identity = parsePtyOwnershipTransferWireIdentity(args.identity)
  const store = new OrcadOutgoingCaptureStore(userDataPath)
  const saved = store.read(identity)
  if (!saved) {
    throw new Error('orcad_outgoing_capture_missing')
  }
  return withOutgoingOrcadAuthority(
    userDataPath,
    {
      binding: saved,
      signal: args.signal,
      assertEvidence: () => {
        if (
          serializeOrcadMigrationValue(store.read(identity)) !== serializeOrcadMigrationValue(saved)
        ) {
          throw new Error('orcad_outgoing_capture_authority_changed')
        }
      }
    },
    ({ pairingCode, assertAuthority }) =>
      publishOutgoingOrcadCapture({
        store,
        identity,
        destinationEnvironmentId: saved.destinationEnvironmentId,
        sourceSshTargetId: saved.sourceSshTargetId,
        sourceSshTargetGeneration: saved.sourceSshTargetGeneration,
        pairingCode,
        signal: args.signal,
        assertAuthority
      })
  )
}
