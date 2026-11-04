import { OrcaRuntimeWithCloseMobileSessionTab } from '../session-lifecycle/close/close-mobile-session-tab'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { retireStructuredAgentSessionTabFrom } from '../agent-session/structured-agent-session-tab-retirement'
import { chatTabChangesMatchingIndex } from '../agent-session/structured-agent-session-tab-index-seed'
import { chatTabId, type ChatTabChange } from '../agent-session/agent-session-tab-layout'
import { structuredSessionTabRetired } from '../structured-worker-custody'

type ChatTabOpen = Extract<ChatTabChange, { open: unknown }>['open']

/** Chat-tab changes that make each worktree's saved tabs match the restored sessions. */
export function restoredChatTabChanges(
  savedTabsByWorktree: Parameters<typeof chatTabChangesMatchingIndex>[0],
  host: ReturnType<typeof getStructuredAgentSessionHost>,
  restored: readonly { workspaceId: string; sessionId: string; agent: ChatTabOpen['agent'] }[],
  live: (id: string) => boolean = () => false
): Map<string, ChatTabChange[]> {
  return chatTabChangesMatchingIndex(
    savedTabsByWorktree,
    restored.map((session) => ({
      worktreeId: session.workspaceId,
      open: {
        sessionId: session.sessionId,
        agent: session.agent,
        tabId: chatTabId(session.sessionId)
      }
    })),
    // A chat a newer Orca wrote is only unreadable here, so it keeps its tab.
    (sessionId) =>
      !!host &&
      structuredSessionTabRetired(host, sessionId) &&
      !live(sessionId) &&
      !host.deps?.store?.isSessionUnreadable?.(sessionId)
  )
}

export abstract class OrcaRuntimeWithStructuredSessionTabProjection extends OrcaRuntimeWithCloseMobileSessionTab {
  protected passiveStructuredSessionTabChangeEligible(change: ChatTabChange): boolean {
    const host = getStructuredAgentSessionHost()
    if ('open' in change) {
      return host?.isSessionTabVisible(change.open.sessionId) ?? false
    }
    return (
      !!host &&
      structuredSessionTabRetired(host, change.close) &&
      !host.deps.store.isSessionUnreadable(change.close) &&
      !this.hasCurrentLocalStructuredSessionTab(change.close)
    )
  }

  /** Prune runtime snapshots after proven close/release; durable visibility alone leaves dead chat rows. Renderer-free for startup reconciliation and orchestration cleanup. */
  retireStructuredAgentSessionTabFromSnapshot(sessionId: string): boolean {
    let retired = false
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (this.workspaceSessions.tryGetHostId(worktreeId) !== LOCAL_EXECUTION_HOST_ID) {
        continue
      }
      const nextSnapshot = retireStructuredAgentSessionTabFrom(snapshot, sessionId)
      if (!nextSnapshot) {
        continue
      }
      this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
      this.emitMobileSessionTabsSnapshot(nextSnapshot)
      retired = true
    }
    return retired
  }

  private readonly localStructuredTabs = new WeakMap<
    RuntimeMobileSessionTabsSnapshot,
    ReadonlySet<string>
  >()

  protected hasCurrentLocalStructuredSessionTab(sessionId: string): boolean {
    const record = getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)
    if (
      !record ||
      record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      this.workspaceSessions.tryGetHostId(record.location.workspaceId) !== LOCAL_EXECUTION_HOST_ID
    ) {
      return false
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(record.location.workspaceId)
    if (!snapshot) {
      return false
    }
    let ids = this.localStructuredTabs.get(snapshot)
    if (!ids) {
      ids = new Set(
        snapshot.tabs.flatMap((tab) => (tab.type === 'agent-session' ? [tab.sessionId] : []))
      )
      this.localStructuredTabs.set(snapshot, ids)
    }
    return ids.has(sessionId)
  }
}
