import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { projectSessionTabAgentStatus } from './session-tab-agent-status-projection'
import {
  projectSessionTabBrowserPlacements,
  type ClientHostedPageHosts
} from './session-tab-browser-placement-projection'
import { projectSessionTabFileHosts } from './session-tab-file-host-projection'

/** A workspace teammate's own tabs in the agent's home (`teammateSessionTabsOf`); absent for anyone else. */
export type SessionTabsPersonFilter = (
  snapshot: RuntimeMobileSessionTabsResult
) => RuntimeMobileSessionTabsResult

export function projectSessionTabsForClient(
  shown: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: Parameters<typeof projectSessionTabAgentStatus>[2],
  hosts: ClientHostedPageHosts,
  person?: SessionTabsPersonFilter | null
): RuntimeMobileSessionTabsResult {
  const snapshot = person ? person(shown) : shown
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
    clientCapabilities,
    hosts
  )
}

/** Desktops show chat status from the status feed, never from tabs[].chatStatus; its freshness
 *  stamps alone would turn version-only frames into full desktop reconciles. Phones keep it. */
export function projectSessionTabsForInventoryStream(
  snapshot: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: Parameters<typeof projectSessionTabAgentStatus>[2],
  hosts: ClientHostedPageHosts,
  person?: SessionTabsPersonFilter | null
): RuntimeMobileSessionTabsResult {
  const projected = projectSessionTabsForClient(
    snapshot,
    clientKind,
    clientCapabilities,
    hosts,
    person
  )
  if (
    clientKind === 'mobile' ||
    !projected.tabs.some((tab) => tab.type === 'agent-session' && tab.chatStatus)
  ) {
    return projected
  }
  return {
    ...projected,
    tabs: projected.tabs.map((tab) => {
      if (tab.type !== 'agent-session' || !tab.chatStatus) {
        return tab
      }
      const { chatStatus: _phoneOnly, ...desktop } = tab
      return desktop
    })
  }
}
