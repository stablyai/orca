import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { HOST_AGENT_PRESENCE_STATUS } from '../../runtime-mobile-agent-presence-projection'

export function projectSessionTabPresenceForClient(
  snapshot: RuntimeMobileSessionTabsResult,
  capabilities: readonly string[] | undefined
): RuntimeMobileSessionTabsResult {
  const supported = capabilities?.includes(AGENT_PROCESS_PRESENCE_RUNTIME_CAPABILITY) === true
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal') {
        return tab
      }
      if (!(HOST_AGENT_PRESENCE_STATUS in tab)) {
        return tab
      }
      const { [HOST_AGENT_PRESENCE_STATUS]: status, ...legacy } = tab
      // The symbol is produced only by the execution host's in-process projection.
      if (!supported || !status || typeof status !== 'object' || !('agentPresence' in status)) {
        return legacy
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This private symbol is minted only by projectHostAgentPresenceStatus; JSON cannot supply it.
      const hostStatus = status as AgentStatusEntry
      // Why: presence is an identity fact; the published row keeps its history, labels and title
      // corrections. The host row stands in only when a pane published no status at all.
      return {
        ...legacy,
        agentStatus: legacy.agentStatus
          ? { ...legacy.agentStatus, agentPresence: hostStatus.agentPresence }
          : hostStatus
      }
    })
  }
}
