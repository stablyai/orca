import { OrcaRuntimeWithDelegatedRetirementRecovery } from './orca-runtime-delegated-retirement-recovery'
import type { OrcadDelegatedExitEvent } from '../orcad/orcad-delegated-exit-delivery'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'

export class OrcaRuntimeWithDelegatedTerminalExit extends OrcaRuntimeWithDelegatedRetirementRecovery {
  private readonly deliveredDelegatedExits = new Map<string, string>()

  acceptDelegatedPtyExit(event: OrcadDelegatedExitEvent): void {
    const { identity, exit, surfaceBinding: binding, destinationClaim: claim } = event
    const signature = JSON.stringify({
      identity,
      exit,
      binding,
      claim,
      finalOutputSeq: event.finalOutputSeq
    })
    const previous = this.deliveredDelegatedExits.get(identity.bridgeId)
    if (previous !== undefined) {
      if (previous !== signature) {
        throw new Error('pty_ownership_transfer_runtime_exit_conflict')
      }
      return
    }
    const registry = this.ptyOwnershipTransferDestinationRegistry
    const snapshot = registry?.get(identity.bridgeId)?.snapshot()
    const outbox = registry?.getDelegatedModelOutbox(identity)
    const output = outbox?.load(identity)
    if (
      !snapshot ||
      !samePtyOwnershipTransferIdentity(snapshot.identity, identity) ||
      snapshot.phase !== 'published' ||
      !snapshot.publicationReceipt ||
      snapshot.executionVerdict !== 'exited' ||
      !snapshot.exit ||
      JSON.stringify(snapshot.exit) !== JSON.stringify(exit) ||
      JSON.stringify(snapshot.surfaceBinding) !== JSON.stringify(binding) ||
      binding.executionHostId !== 'local' ||
      !snapshot.delegatedClaimActive ||
      snapshot.delegatedClaim?.generation !== claim.generation ||
      snapshot.delegatedClaim.claimId !== claim.claimId ||
      snapshot.liveOutputEndSeq !== event.finalOutputSeq ||
      !outbox ||
      !output ||
      output.pendingFrames.length !== 0 ||
      output.acceptedEndSeq !== event.finalOutputSeq ||
      output.acknowledgedEndSeq !== event.finalOutputSeq
    ) {
      throw new Error('pty_ownership_transfer_runtime_exit_unverifiable')
    }
    if (!outbox.loadRetirement(identity)) {
      validatePtyOwnershipTransferDestinationOutputRoute(
        {
          runtimeId: this.runtimeId,
          inspectPty: (id) => this.ptysById.get(id) ?? null
        },
        identity,
        binding
      )
    }
    outbox.recordRetirement(identity, { phase: 'prepared', event })
    // Exit listeners can synchronously re-enter the callback.
    this.deliveredDelegatedExits.set(identity.bridgeId, signature)
    try {
      this.recoverDelegatedPtyRetirement({ retirement: outbox.loadRetirement(identity)!, outbox })
    } catch (error) {
      this.deliveredDelegatedExits.delete(identity.bridgeId)
      throw error
    }
  }
}
