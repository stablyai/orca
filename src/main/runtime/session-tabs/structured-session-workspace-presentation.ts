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

  /** Drop a moved chat's rows at its one former workspace now; ingress, preservation and restore keep it out after. */
  async retireMovedStructuredSessionPlacement(sessionId: string, oldId: string): Promise<void> {
    const moved = () => !structuredSessionPlacementAllowed(this.store, oldId, sessionId)
    if (!moved()) {
      return
    }
    const tab = this.store
      ?.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID)
      ?.unifiedTabs?.[oldId]?.find(
        (candidate) =>
          savedSessionId(candidate) === sessionId &&
          (!candidate.executionHostId || candidate.executionHostId === LOCAL_EXECUTION_HOST_ID)
      )
    if (tab) {
      await this.changeWindowlessChatTabs(oldId, [{ close: sessionId, tabId: tab.id }], moved)
    }
    const raw = this.mobileSessionTabsByWorktree
      .get(oldId)
      ?.tabs.find(
        (candidate) => candidate.type === 'agent-session' && candidate.sessionId === sessionId
      )
    if (raw && moved()) {
      this.retireStructuredAgentSessionTabFromSnapshot(sessionId, raw.id, oldId)
    }
  }
}
