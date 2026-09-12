import type { parsePtyOwnershipTransferDestinationInspectionRequest } from '../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import type { RequestContext } from './dispatcher'
import {
  relayPtyOwnershipTransferExecutionVerdict,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import {
  requireDestinationProof,
  isRelayPtyOwnershipTransferDestinationClaimActive
} from './relay-pty-ownership-transfer-destination-claim'

export async function inspectRelayPtyOwnershipTransferDestination<T>(
  state: RelayPtyOwnershipTransferAdapterState,
  request: ReturnType<typeof parsePtyOwnershipTransferDestinationInspectionRequest>,
  context: RequestContext,
  inspect:
    | ((identity: PtyOwnershipTransferWireIdentity, isAuthorized: () => boolean) => Promise<T>)
    | undefined
): Promise<T> {
  const { transfer } = requireDestinationProof(state, request, context)
  const isAuthorized = () =>
    isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      request.destinationClaim,
      context
    ) && relayPtyOwnershipTransferExecutionVerdict(state, transfer) === 'live'
  if (!inspect || !isAuthorized()) {
    throw new Error('pty_ownership_transfer_destination_inspection_unverifiable')
  }
  const result = await inspect(transfer.identity, isAuthorized)
  if (!isAuthorized()) {
    throw new Error('pty_ownership_transfer_destination_inspection_unverifiable')
  }
  return result
}
