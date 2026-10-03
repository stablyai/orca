import { readAgentProcessPresence } from '../../../../shared/agent-process-presence'
import { AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { HOST_AGENT_PRESENCE } from '../../runtime-mobile-agent-presence-projection'

/** Presence rides beside the turn: `agentPresence` is the owner, `agentStatus` stays the turn. */
export function projectSessionTabPresenceForClient(
  snapshot: RuntimeMobileSessionTabsResult,
  capabilities: readonly string[] | undefined
): RuntimeMobileSessionTabsResult {
  const supported = capabilities?.includes(AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY) === true
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal' || !(HOST_AGENT_PRESENCE in tab)) {
        return tab
      }
      const { [HOST_AGENT_PRESENCE]: hostPresence, ...legacy } = tab
      // The symbol is produced only by the execution host's in-process projection.
      const agentPresence = supported ? readAgentProcessPresence(hostPresence) : undefined
      return agentPresence ? { ...legacy, agentPresence } : legacy
    })
  }
}
