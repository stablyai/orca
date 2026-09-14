import type { SshRelaySession } from '../ssh/ssh-relay-session'
import { setSshActiveMultiplexerResolver } from '../ssh/ssh-target-registry'

// One session per SSH target owns the whole relay lifecycle (mux, providers, abort controller, state machine).
export const activeSessions = new Map<string, SshRelaySession>()

// Why at module scope: this resolver is pure state lookup with no handler lifecycle, so
// installing it on import keeps it correct even before registerSshHandlers runs.
setSshActiveMultiplexerResolver(
  (connectionId) => activeSessions.get(connectionId)?.getMux() ?? undefined
)
