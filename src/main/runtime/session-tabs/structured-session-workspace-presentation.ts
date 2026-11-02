import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import type { ChatTabChange } from '../agent-session/agent-session-tab-layout'
import { structuredSessionPlacementAllowed } from './structured-session-placement'
import { OrcaRuntimeWithStructuredSessionTabProjection } from './restored-chat-tab-changes'
import { projectStructuredSessionTab } from './structured-session-tab-publication'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

export abstract class OrcaRuntimeWithStructuredSessionWorkspacePresentation extends OrcaRuntimeWithStructuredSessionTabProjection {
  protected abstract changeWindowlessChatTabs(
    worktreeId: string,
    changes: readonly ChatTabChange[],
    eligible?: (change: ChatTabChange) => boolean
  ): Promise<void>

  /** After a chat moves, every workspace that may still show it, under any spelling, in a saved
   *  layout or a stored frame, republishes at a newer version without it, so clients holding the
   *  old slice replace it. Runs only on an actual move. */
  async retireMovedStructuredSessionPlacement(sessionId: string): Promise<void> {
    const misplaced = (workspaceId: string) =>
      !structuredSessionPlacementAllowed(workspaceId, sessionId)
    const savedTabIds = new Map<string, string>()
    const saved = this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {}
    for (const [workspaceId, tabs] of Object.entries(saved)) {
      // Null for other hosts' tabs: only this machine's chats follow its records.
      const tab = tabs.find((candidate) => savedSessionId(candidate) === sessionId)
      if (tab && misplaced(workspaceId)) {
        savedTabIds.set(workspaceId, tab.id)
      }
    }
    const host = getStructuredAgentSessionHost()
    const keys = new Set(savedTabIds.keys())
    for (const [workspaceId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (
        snapshot.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === sessionId) &&
        misplaced(workspaceId)
      ) {
        keys.add(workspaceId)
      }
    }
    for (const workspaceId of keys) {
      const tabId = savedTabIds.get(workspaceId)
      // Main's layout owner closes the saved tab; a window-owned layout drops it on read and save.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && tabId) {
        await this.changeWindowlessChatTabs(workspaceId, [{ close: sessionId, tabId }], () =>
          misplaced(workspaceId)
        )
      }
      // The slice keeps the other chats this workspace holds, so replacing it drops only this one.
      for (const tab of saved[workspaceId] ?? []) {
        const id = savedSessionId(tab)
        if (
          id &&
          id !== sessionId &&
          tab.agentSessionAgent &&
          host?.isSessionTabVisible(id) &&
          structuredSessionPlacementAllowed(workspaceId, id)
        ) {
          projectStructuredSessionTab(
            this,
            { workspaceId, sessionId: id, agent: tab.agentSessionAgent, activate: false },
            () => {}
          )
        }
      }
      // A workspace the host never framed still gets one, listing what it shows there.
      const snapshot = this.mobileSessionTabsByWorktree.get(workspaceId) ?? {
        worktree: workspaceId,
        publicationEpoch: `structured:${Date.now().toString(36)}`,
        snapshotVersion: 0,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabGroups: [],
        tabs: []
      }
      this.emitMobileSessionTabsSnapshot(this.storeMobileSessionSnapshot(workspaceId, snapshot))
    }
  }
}
