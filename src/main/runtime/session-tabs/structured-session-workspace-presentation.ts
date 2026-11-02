import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import type { ChatTabChange } from '../agent-session/agent-session-tab-layout'
import { structuredSessionPlacementAllowed } from './structured-session-placement'
import { OrcaRuntimeWithStructuredSessionTabProjection } from './restored-chat-tab-changes'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { mobileChatTabId } from '../agent-session/agent-session-tab-identity'
import {
  isReopenedChatTabId,
  isStructuredAgentSessionHostTabId
} from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import {
  completeStructuredWorkspaceProjection,
  type StructuredWorkspaceChatContext
} from './structured-session-workspace-projection'

export abstract class OrcaRuntimeWithStructuredSessionWorkspacePresentation extends OrcaRuntimeWithStructuredSessionTabProjection {
  protected abstract changeWindowlessChatTabs(
    worktreeId: string,
    changes: readonly ChatTabChange[],
    eligible?: (change: ChatTabChange) => boolean
  ): Promise<void>

  /** After a chat moves, every workspace that may still show it, under any spelling, in a saved
   *  layout or a stored frame, gets back its whole frame without it, through the one projection
   *  that also completes a window's resend. A window owns its workspaces' content, so it is asked
   *  to resend; this host projects only workspaces it already publishes and owns the layout of.
   *  Runs only on an actual move. */
  async retireMovedStructuredSessionPlacement(sessionId: string): Promise<void> {
    const misplaced = (workspaceId: string) =>
      !structuredSessionPlacementAllowed(workspaceId, sessionId)
    const savedTabIds = new Map<string, string>()
    const session = this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
    const saved = session?.unifiedTabs ?? {}
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
    const context = this.structuredWorkspaceChatContext()
    for (const workspaceId of keys) {
      const tabId = savedTabIds.get(workspaceId)
      // Main's layout owner closes the saved tab; a window-owned layout drops it on read and save.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && tabId) {
        await this.changeWindowlessChatTabs(workspaceId, [{ close: sessionId, tabId }], () =>
          misplaced(workspaceId)
        )
      }
      if (windowOwned) {
        // Without an accepted pair, the window's next graph sync is answered with a resend of
        // this workspace, even when its counts are unchanged.
        this.acceptedRendererMobileSnapshotByWorktree.delete(workspaceId)
        continue
      }
      // A workspace this host does not publish stays unpublished, so a removed one is not resurfaced.
      const held = this.mobileSessionTabsByWorktree.get(workspaceId)
      if (!held) {
        continue
      }
      const owner = session
        ? this.buildHeadlessWorkspaceSnapshot(
            workspaceId,
            session.tabsByWorktree[workspaceId] ?? [],
            session,
            held,
            { onlyRuntimeOwnedTerminals: false, runtimeOwnedOnly: false, keepEmpty: true }
          )
        : null
      const members = (saved[workspaceId] ?? []).flatMap((tab) => {
        const id = savedSessionId(tab)
        return id ? [mobileChatTabId(id)] : []
      })
      const projection = completeStructuredWorkspaceProjection(owner, members, context)
      if (projection.kind === 'complete') {
        this.emitMobileSessionTabsSnapshot(
          this.storeMobileSessionSnapshot(workspaceId, projection.snapshot)
        )
      }
    }
  }

  /** One read of what this host knows about chats, shared by every workspace a batch projects. */
  protected structuredWorkspaceChatContext(): StructuredWorkspaceChatContext {
    const store = getStructuredAgentSessionHost()?.deps.store
    let reopened: Map<string, string> | undefined
    return {
      sessionOfTab: (tabId) => {
        if (isStructuredAgentSessionHostTabId(tabId)) {
          return tabId.slice('agent-session:'.length)
        }
        if (!store || !isReopenedChatTabId(tabId)) {
          return null
        }
        if (!reopened) {
          reopened = new Map()
          for (const id of store.listVisibleSessionIds()) {
            const visibleTabId = store.getSessionTabId(id)
            if (visibleTabId) {
              reopened.set(visibleTabId, id)
            }
          }
        }
        return reopened.get(tabId) ?? null
      },
      placedChat: (workspaceId, id) => {
        const conversation = store?.getConversation(id)
        return conversation && structuredSessionPlacementAllowed(workspaceId, id)
          ? { agent: conversation.provider }
          : null
      }
    }
  }
}
