import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'
import { projectSessionTabBrowserPlacements } from './session-tab-browser-placement-projection'
import { projectSessionTabFileHosts } from './session-tab-file-host-projection'

export function projectSessionTabsForClient(
  snapshot: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: Parameters<typeof projectSessionTabAgentStatus>[2]
): RuntimeMobileSessionTabsResult {
  // Phones draw no agent message cards, so they never pay for sender identity.
  const { agentSenderAssociations: _desktopOnly, ...phone } = snapshot
  return projectSessionTabBrowserPlacements(
    projectSessionTabFileHosts(
      projectSessionTabAgentStatus(
        clientKind === 'mobile' ? phone : snapshot,
        clientKind,
        clientCapabilities
      ),
      clientKind
    ),
    clientCapabilities
  )
}
