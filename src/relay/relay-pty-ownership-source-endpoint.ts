import type { RelayDispatcher } from './dispatcher'
import {
  PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD,
  parsePtyOwnershipSourceEndpoint
} from '../shared/pty-ownership-source-endpoint'
import { parsePtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import type { RelayPtySourcePublication } from './relay-pty-source-publication'
import type { PtyHandler } from './pty-handler'

export function registerRelayPtyOwnershipSourceEndpoint(options: {
  enabled: boolean
  dispatcher: Pick<RelayDispatcher, 'onRequest'>
  source: Pick<RelayPtySourcePublication['ownershipTransfer'], 'authorizes'>
  handler: Pick<PtyHandler, 'resolveOwnershipTransferTerminal'>
  readEndpoint: () => {
    endpoint: string
    incumbentVersion: string
    endpointCredential: string
  } | null
}) {
  if (!options.enabled) {
    return
  }
  options.dispatcher.onRequest(PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD, async (params, context) => {
    if (
      context.isStale() ||
      !context.sessionIdentity?.authenticated ||
      !context.sessionIdentity.allowSessionOwner
    ) {
      throw new Error('pty_ownership_source_endpoint_unauthorized')
    }
    const identity = parsePtyOwnershipTransferWireIdentity(params)
    if (
      params.version !== 1 ||
      !options.source.authorizes(
        identity.terminalId,
        identity.ownerLease,
        identity.sourceOwnerGeneration,
        context.clientId
      ) ||
      options.handler.resolveOwnershipTransferTerminal(identity.terminalId)?.incarnationId !==
        identity.incarnationId
    ) {
      throw new Error('pty_ownership_source_endpoint_unauthorized')
    }
    const endpoint = options.readEndpoint()
    if (!endpoint || context.isStale()) {
      throw new Error('pty_ownership_source_endpoint_unverifiable')
    }
    return parsePtyOwnershipSourceEndpoint({ version: 1, ...endpoint, identity }, identity)
  })
}
