import { bindOutgoingOrcadSource } from './orcad-outgoing-source-binding'
import {
  PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD,
  parsePtyOwnershipSourceEndpoint
} from '../../shared/pty-ownership-source-endpoint'

export async function discoverOutgoingOrcadSourceEndpoint(
  options: Parameters<typeof bindOutgoingOrcadSource>[0]
) {
  const source = bindOutgoingOrcadSource(options)
  const capabilities = await source.provider.getOwnershipBridgeCapabilities?.({
    signal: options.signal
  })
  source.assertSource()
  if (!capabilities?.liveTransfer || capabilities.destinationDelegationVersion !== 1) {
    throw new Error('orcad_outgoing_preparation_unsupported')
  }
  const reply = await source.request(
    PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD,
    {
      version: 1,
      ...source.identity
    },
    { signal: options.signal, timeoutMs: 5_000 }
  )
  source.assertSource()
  return parsePtyOwnershipSourceEndpoint(reply, source.identity)
}
