import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import type { ChatTabChange } from '../agent-session/agent-session-tab-layout'
import { structuredSessionPlacementAllowed } from './structured-session-placement'
import { OrcaRuntimeWithStructuredSessionTabProjection } from './restored-chat-tab-changes'

export abstract class OrcaRuntimeWithStructuredSessionWorkspacePresentation extends OrcaRuntimeWithStructuredSessionTabProjection {
  protected abstract changeWindowlessChatTabs(
    worktreeId: string,
    changes: readonly ChatTabChange[],
    eligible?: (change: ChatTabChange) => boolean
  ): Promise<void>

  /** After a chat moves, each layout still holding it, under any workspace spelling, re-derives
   *  without it: a host-owned saved tab closes, and every stored frame republishes at a newer
   *  version so clients holding the old one replace it. Runs only on an actual move. */
  async retireMovedStructuredSessionPlacement(sessionId: string): Promise<void> {
    const misplaced = (workspaceId: string) =>
      !structuredSessionPlacementAllowed(workspaceId, sessionId)
    const saved = this.store?.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {}
    for (const [workspaceId, tabs] of Object.entries(saved)) {
      const tab = tabs.find(
        (candidate) =>
          savedSessionId(candidate) === sessionId &&
          (!candidate.executionHostId || candidate.executionHostId === LOCAL_EXECUTION_HOST_ID)
      )
      if (tab && misplaced(workspaceId)) {
        await this.changeWindowlessChatTabs(
          workspaceId,
          [{ close: sessionId, tabId: tab.id }],
          () => misplaced(workspaceId)
        )
      }
    }
    for (const [workspaceId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (
        misplaced(workspaceId) &&
        snapshot.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === sessionId)
      ) {
        this.emitMobileSessionTabsSnapshot(this.storeMobileSessionSnapshot(workspaceId, snapshot))
      }
    }
  }
}
