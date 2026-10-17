import type { RuntimeMobileSessionClientTab } from '../../shared/runtime-types'
import { findWorkspaceCreationTab } from '../../shared/workspace-creation-tab'
import type { ClientSessionTabSelection } from './client-session-tab-selection'

/**
 * The selection a device projects from: its own pick, or, until it has made one, the tab the
 * workspace was created for. A cached topology fallback is not a pick, so it never outranks that.
 */
export function selectionBeforeDevicePick(
  state: { selection: ClientSessionTabSelection; shouldPersist: boolean },
  tabs: readonly RuntimeMobileSessionClientTab[],
  createdWithAgent: string | undefined
): ClientSessionTabSelection {
  const creationTab = state.shouldPersist
    ? undefined
    : findWorkspaceCreationTab(tabs, createdWithAgent, (tab) =>
        tab.type === 'agent-session'
          ? tab.agent
          : tab.type === 'terminal'
            ? tab.launchAgent
            : undefined
      )
  return creationTab
    ? { activeTabId: creationTab.id, activeGroupId: null, activeTabIdByGroupId: {} }
    : state.selection
}
