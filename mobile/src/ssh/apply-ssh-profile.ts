import { connect } from '../transport/rpc-client'
import { racePairingCandidates } from '../transport/pairing-candidate-race'
import { createSshConnectionRoute } from '../transport/ssh-connection-route'
import { updateHostConnectionRoute } from '../transport/host-connection-route-store'
import type { ConnectionLogSink, HostProfile } from '../transport/types'
import { routeFromSshProfile, wsEndpointPort, type SshProfile } from './ssh-profile'

// Test the profile against the host's endpoint, then persist it as the host's route.
export async function applySshProfileToHost(args: {
  host: HostProfile
  profile: SshProfile
  jumpProfile?: SshProfile
  signal: AbortSignal
  onLog: ConnectionLogSink
}): Promise<void> {
  const route = routeFromSshProfile(
    args.profile,
    wsEndpointPort(args.host.endpoint),
    args.jumpProfile
  )
  const client = connect(args.host.endpoint, args.host.deviceToken, args.host.publicKeyB64, {
    routeProvider: createSshConnectionRoute(route),
    onLog: args.onLog
  })
  const close = () => client.close()
  args.signal.addEventListener('abort', close, { once: true })
  try {
    await racePairingCandidates([{ path: 'direct', client }])
    if (args.signal.aborted) {
      throw new Error('Connection cancelled.')
    }
    await updateHostConnectionRoute(args.host.id, route)
  } finally {
    args.signal.removeEventListener('abort', close)
    close()
  }
}
