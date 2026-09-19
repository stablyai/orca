import { OrcaRuntimeWithDelegatedTerminalRegistration } from './orca-runtime-delegated-terminal-registration'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import type { RuntimePtyOwnershipTransferModelCheckpoint } from './runtime-ownership-transfer-contracts'
import type { PtyOwnershipModelClearRequest } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-model-clear'

type DelegatedModelState = {
  identity: PtyOwnershipTransferWireIdentity
  busy: boolean
  poisoned: boolean
  clearRevision: number
  pending?: RuntimePtyOwnershipTransferModelCheckpoint
  pendingClear?: PtyOwnershipModelClearRequest
  clearCompletion?: Promise<void>
}

export class OrcaRuntimeWithDelegatedModelState extends OrcaRuntimeWithDelegatedTerminalRegistration {
  private readonly delegatedModels = new Map<string, DelegatedModelState>()

  protected delegatedModelState(identity: PtyOwnershipTransferWireIdentity): DelegatedModelState {
    let state = this.delegatedModels.get(identity.bridgeId)
    if (!state) {
      state = {
        identity: Object.freeze({ ...identity }),
        busy: false,
        poisoned: false,
        clearRevision: 0
      }
      this.delegatedModels.set(identity.bridgeId, state)
    }
    if (!samePtyOwnershipTransferIdentity(state.identity, identity)) {
      throw new Error('pty_ownership_transfer_model_identity_conflict')
    }
    return state
  }

  override async restoreDelegatedPtyOwnershipModel(
    identity: PtyOwnershipTransferWireIdentity,
    signal?: AbortSignal
  ) {
    const result = await super.restoreDelegatedPtyOwnershipModel(identity, signal)
    const state = this.delegatedModelState(identity)
    state.clearRevision =
      this.ptyOwnershipTransferDestinationRegistry!.getDelegatedModelOutbox(
        identity
      )!.loadModelClear(identity)?.operationIds.length ?? 0
    return result
  }
}
