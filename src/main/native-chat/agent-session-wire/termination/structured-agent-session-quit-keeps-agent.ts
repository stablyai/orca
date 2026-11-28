import {
  hasAttachedProviderRelay,
  providerRelayHandedOffAtQuit,
  providerRelayReattached
} from '../../../provider-relay/app-provider-relays'
import type { StructuredAgentSessionProviderChild } from '../host/structured-agent-session-host-types'

/** Quit hands this chat's agent to the terminal daemon, which keeps it running, instead of stopping it. */
export function quitKeepsStructuredAgent(
  sessionId: string,
  child: Pick<StructuredAgentSessionProviderChild, 'phase' | 'close'> | null | undefined
): boolean {
  if (!child || child.close) {
    return false
  }
  // A kept agent still reopening goes back to the daemon; any other start is stopped.
  if (child.phase === 'starting' && !providerRelayReattached(sessionId)) {
    return false
  }
  return providerRelayHandedOffAtQuit(sessionId) || hasAttachedProviderRelay(sessionId)
}
