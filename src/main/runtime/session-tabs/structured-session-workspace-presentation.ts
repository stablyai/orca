import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import type { ChatTabChange } from '../agent-session/agent-session-tab-layout'
import { structuredSessionPlacementAllowed } from './structured-session-placement'
import { OrcaRuntimeWithStructuredSessionTabProjection } from './restored-chat-tab-changes'
import { withStructuredSessionChatTabs } from './structured-session-tab-publication'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { storedFrameFollowsRendererPublication } from '../mobile-session-snapshot-version'
import { mobileChatTabId } from '../agent-session/agent-session-tab-identity'
import { isReopenedChatTabId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import type { Tab } from '../../../shared/tab-types'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'

export abstract class OrcaRuntimeWithStructuredSessionWorkspacePresentation extends OrcaRuntimeWithStructuredSessionTabProjection {
  protected abstract changeWindowlessChatTabs(
    worktreeId: string,
    changes: readonly ChatTabChange[],
    eligible?: (change: ChatTabChange) => boolean
  ): Promise<void>

  /** After a chat moves, every workspace that may still show it, under any spelling, in a saved
   *  layout or a stored frame, republishes without it. A frame says what its whole workspace
   *  holds, so only a complete one goes out: the window's own, or one this host builds when it
   *  owns the layout. A window whose frame is missing or not its own is asked to resend instead.
   *  Runs only on an actual move. */
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
    const keys = new Set(savedTabIds.keys())
    for (const [workspaceId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (
        snapshot.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === sessionId) &&
        misplaced(workspaceId)
      ) {
        keys.add(workspaceId)
      }
    }
    const windowOwned = Boolean(this.getAvailableAuthoritativeWindow())
    for (const workspaceId of keys) {
      const tabId = savedTabIds.get(workspaceId)
      // Main's layout owner closes the saved tab; a window-owned layout drops it on read and save.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && tabId) {
        await this.changeWindowlessChatTabs(workspaceId, [{ close: sessionId, tabId }], () =>
          misplaced(workspaceId)
        )
      }
      if (
        windowOwned &&
        !storedFrameFollowsRendererPublication(
          this.mobileSessionTabsByWorktree.get(workspaceId),
          this.acceptedRendererMobileSnapshotByWorktree.get(workspaceId)
        )
      ) {
        // Without an accepted pair, the window's next graph sync is answered with a resend of
        // this workspace, even when its counts are unchanged.
        this.acceptedRendererMobileSnapshotByWorktree.delete(workspaceId)
        continue
      }
      if (!windowOwned) {
        // The host's own complete frame from its saved layout; a removed workspace gets none.
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(workspaceId)
      }
      const snapshot = this.mobileSessionTabsByWorktree.get(workspaceId)
      if (snapshot) {
        const retained = this.retainedSavedChatTabs(
          workspaceId,
          snapshot,
          saved[workspaceId] ?? [],
          sessionId
        )
        this.emitMobileSessionTabsSnapshot(
          this.storeMobileSessionSnapshot(
            workspaceId,
            retained.length
              ? withStructuredSessionChatTabs(snapshot, workspaceId, retained)
              : snapshot
          )
        )
      }
    }
  }

  /** Visible chats placed here that the saved layout holds and the frame does not list yet, from
   *  their records; the saved agent label is only a hint, so it never decides membership. */
  private retainedSavedChatTabs(
    workspaceId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    savedTabs: readonly Tab[],
    movedSessionId: string
  ): RuntimeMobileSessionAgentTab[] {
    const host = getStructuredAgentSessionHost()
    const listed = new Set([movedSessionId])
    for (const tab of snapshot.tabs) {
      if (tab.type === 'agent-session') {
        listed.add(tab.sessionId)
      }
    }
    return savedTabs.flatMap((tab) => {
      const id = savedSessionId(tab)
      const record =
        id &&
        !listed.has(id) &&
        host?.isSessionTabVisible(id) &&
        structuredSessionPlacementAllowed(workspaceId, id)
          ? host.deps.store.getConversation(id)
          : null
      if (!id || !record) {
        return []
      }
      listed.add(id)
      return [
        {
          type: 'agent-session' as const,
          id: isReopenedChatTabId(tab.id) ? tab.id : mobileChatTabId(id),
          title: defaultAgentChatLabel(record.provider),
          sessionId: id,
          agent: record.provider,
          isActive: false
        }
      ]
    })
  }
}
