import type { RelayDispatcher } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapterOptions } from './relay-pty-ownership-transfer-adapter-contract'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { retireRelayPtySuccessorSourceDelivery } from './relay-pty-successor-retirement-ingress'
import {
  PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD,
  parsePtyOwnershipTransferSuccessorRetirementRequest,
  parsePtyOwnershipTransferSuccessorRetirementResult
} from '../shared/pty-ownership-transfer-successor-retirement'

export function supportsRelayPtySuccessorRetirement(
  options: RelayPtyOwnershipTransferAdapterOptions
): boolean {
  const deps = options.successorRetirementDependencies
  return (
    !!options.store &&
    options.enableSourceDeliveryRetirement === true &&
    options.enableDestinationDelegationClaims === true &&
    options.enableDestinationDelegationCommit === true &&
    options.enableDestinationOutputRetention === true &&
    typeof deps?.handler?.beginOwnershipTransferCaptureIngress === 'function' &&
    typeof deps?.publication?.prepareCoveredOwnershipTransferRetirement === 'function' &&
    typeof deps?.publication?.ownershipTransfer?.authorizesResumedTransferAtGeneration ===
      'function' &&
    typeof deps?.publication?.ownershipTransfer?.inspectSuccessorRetainedDelivery === 'function'
  )
}

export function registerRelayPtySuccessorRetirement(
  dispatcher: RelayDispatcher,
  state: RelayPtyOwnershipTransferAdapterState
): void {
  if (!supportsRelayPtySuccessorRetirement(state.options)) {
    return
  }
  dispatcher.onRequest(
    PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD,
    async (value, context) => {
      if (!supportsRelayPtySuccessorRetirement(state.options)) {
        throw new Error('pty_successor_retirement_unavailable')
      }
      const request = parsePtyOwnershipTransferSuccessorRetirementRequest(value)
      const result = retireRelayPtySuccessorSourceDelivery(
        state,
        request,
        request.savedBaseline,
        request.successorGeneration,
        request.retirementRecordSha256,
        request.recoveryOnly,
        context,
        state.options.successorRetirementDependencies!
      )
      return parsePtyOwnershipTransferSuccessorRetirementResult({ ...result, version: 1 }, request)
    }
  )
}
