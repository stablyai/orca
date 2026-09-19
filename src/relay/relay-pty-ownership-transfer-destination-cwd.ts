import {
  parsePtyOwnershipTransferDestinationCwdRequest,
  parsePtyOwnershipTransferDestinationCwdResult
} from '../shared/pty-ownership-transfer-destination-cwd'
import type { RequestContext } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { inspectRelayPtyOwnershipTransferDestination } from './relay-pty-ownership-transfer-destination-inspection'

export async function inspectRelayPtyOwnershipTransferDestinationCwd(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationCwdRequest(value)
  const cwd = await inspectRelayPtyOwnershipTransferDestination(
    state,
    request,
    context,
    state.options.inspectDestinationCwd
  )
  return parsePtyOwnershipTransferDestinationCwdResult({
    ...request,
    version: 1,
    destinationClaim: request.destinationClaim,
    cwd
  })
}
