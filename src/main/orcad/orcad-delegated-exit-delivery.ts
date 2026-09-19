import type { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import { parsePtyOwnershipTransferDestinationReplayRequest } from '../../shared/pty-ownership-transfer-destination-claim'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import type { PtyOwnershipTransferExit } from '../../shared/pty-ownership-transfer-control-wire'
import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'

export type OrcadDelegatedExitEvent = Readonly<{
  identity: PtyOwnershipTransferWireIdentity
  exit: PtyOwnershipTransferExit
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  destinationClaim: PtyOwnershipTransferDestinationClaim
  finalOutputSeq: number
}>

export function createOrcadDelegatedExitDelivery(options: {
  proof: unknown
  adapter: Pick<PtyOwnershipTransferDestinationAdapter, 'snapshot'>
  outbox: Pick<PtyOwnershipTransferDestinationOutputOutbox, 'load'>
  isActive: () => boolean
  onExit?: (event: OrcadDelegatedExitEvent) => void
}) {
  const proof = parsePtyOwnershipTransferDestinationReplayRequest(options.proof)
  let delivered = false
  let delivering = false
  return () => {
    if (delivered || delivering || !options.onExit || !options.isActive()) {
      return false
    }
    const snapshot = options.adapter.snapshot()
    if (
      !samePtyOwnershipTransferIdentity(snapshot.identity, proof) ||
      snapshot.phase !== 'published' ||
      !snapshot.publicationReceipt ||
      snapshot.surfaceBinding?.executionHostId !== 'local' ||
      snapshot.surfaceBinding.ptyId !== proof.terminalId ||
      !snapshot.delegatedClaimActive ||
      snapshot.delegatedClaim?.generation !== proof.destinationClaim.generation ||
      snapshot.delegatedClaim.claimId !== proof.destinationClaim.claimId ||
      snapshot.executionVerdict !== 'exited' ||
      !snapshot.exit
    ) {
      return false
    }
    const output = options.outbox.load(proof)
    if (
      !output ||
      output.pendingFrames.length > 0 ||
      output.acknowledgedEndSeq !== snapshot.liveOutputEndSeq ||
      output.acceptedEndSeq !== snapshot.liveOutputEndSeq ||
      !options.isActive()
    ) {
      return false
    }
    delivering = true
    try {
      options.onExit(
        Object.freeze({
          identity: Object.freeze({ ...snapshot.identity }),
          exit: Object.freeze({ ...snapshot.exit }),
          surfaceBinding: Object.freeze({ ...snapshot.surfaceBinding }),
          destinationClaim: Object.freeze({ ...snapshot.delegatedClaim }),
          finalOutputSeq: snapshot.liveOutputEndSeq
        })
      )
      delivered = true
      return true
    } finally {
      delivering = false
    }
  }
}
