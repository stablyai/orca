import type { RequestContext } from './dispatcher'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export type RelayNetworkTunnelOwnerSource = Pick<
  SshPtyConsumerSessionAdapter,
  'activeSessionOwner' | 'assertOwnerPublicationSettled'
>

export function captureRelayNetworkTunnelOwner(
  request: { runtimeIncarnation: string; ownerGeneration: number; ownerLease: string },
  context: RequestContext,
  options: {
    runtimeIncarnation: string
    ownsEndpoint: () => boolean
    owners: RelayNetworkTunnelOwnerSource
  }
) {
  const { clientId, transportGeneration } = context
  const { principal, authenticationKind } = context.sessionIdentity ?? {}
  const { runtimeIncarnation, ownerGeneration, ownerLease } = request
  const assertContext = (candidate: RequestContext) => {
    const identity = candidate.sessionIdentity
    if (
      candidate.isStale() ||
      candidate.signal?.aborted ||
      candidate.clientId !== clientId ||
      candidate.transportGeneration !== transportGeneration ||
      identity?.authenticated !== true ||
      identity.allowSessionOwner !== true ||
      !principal ||
      identity.principal !== principal ||
      identity.authenticationKind !== authenticationKind ||
      (authenticationKind !== 'launch-nonce' && authenticationKind !== 'endpoint-credential')
    ) {
      throw new Error('relay_network_tunnel_unauthorized')
    }
  }
  const assertCurrent = () => {
    assertContext(context)
    const owner = options.owners.activeSessionOwner(clientId)
    if (
      !Number.isSafeInteger(transportGeneration) ||
      transportGeneration! < 0 ||
      runtimeIncarnation !== options.runtimeIncarnation ||
      !options.ownsEndpoint() ||
      owner?.ownerGeneration !== ownerGeneration ||
      owner.ownerLease !== ownerLease
    ) {
      throw new Error('relay_network_tunnel_owner_changed')
    }
    options.owners.assertOwnerPublicationSettled()
  }
  assertCurrent()
  return {
    clientId,
    transportGeneration: transportGeneration!,
    assertCurrent,
    assertIncoming: (candidate: RequestContext) => {
      assertCurrent()
      assertContext(candidate)
    }
  }
}
