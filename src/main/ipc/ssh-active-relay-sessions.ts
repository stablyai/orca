import type { SshRelaySession } from '../ssh/ssh-relay-session'
import {
  setDirectSshAuthorityResolver,
  setSshActiveMultiplexerResolver,
  setSshNetworkTunnelResolver
} from '../ssh/ssh-target-registry'

// One session per SSH target owns the whole relay lifecycle (mux, providers, abort controller, state machine).
export const activeSessions = new Map<string, SshRelaySession>()

// Why at module scope: this resolver is pure state lookup with no handler lifecycle, so
// installing it on import keeps it correct even before registerSshHandlers runs.
setSshActiveMultiplexerResolver(
  (connectionId) => activeSessions.get(connectionId)?.getMux() ?? undefined
)
setDirectSshAuthorityResolver((targetId) => activeSessions.has(targetId))
setSshNetworkTunnelResolver(async (targetId, options) => {
  const session = activeSessions.get(targetId)
  if (!session) {
    throw new Error('ssh_network_tunnel_session_unavailable')
  }
  const opened = await session.openNetworkTunnel(options)
  const assertCurrent = () => {
    if (activeSessions.get(targetId) !== session) {
      throw new Error('ssh_network_tunnel_session_changed')
    }
    opened.assertCurrent()
  }
  try {
    assertCurrent()
  } catch (error) {
    opened.tunnel.fail(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
  return {
    ...opened,
    assertCurrent,
    assertAdmission: () => {
      assertCurrent()
      opened.assertAdmission()
    }
  }
})
