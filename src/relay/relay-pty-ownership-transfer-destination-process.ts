import { parsePtyOwnershipTransferDestinationInspectionRequest } from '../shared/pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferDestinationProcessResult } from '../shared/pty-ownership-transfer-destination-process'
import type { RequestContext } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { inspectRelayPtyOwnershipTransferDestination } from './relay-pty-ownership-transfer-destination-inspection'

export async function inspectRelayPtyOwnershipTransferDestinationProcess(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationInspectionRequest(value)
  const inspection = await inspectRelayPtyOwnershipTransferDestination(
    state,
    request,
    context,
    state.options.inspectDestinationProcess
  )
  return parsePtyOwnershipTransferDestinationProcessResult({
    ...request,
    version: 1,
    foregroundProcessEvidence: inspection.foregroundProcessEvidence,
    childProcessEvidence: inspection.childProcessEvidence ?? 'unverifiable'
  })
}
