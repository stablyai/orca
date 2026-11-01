import {
  savedTabHoldsSelection,
  withSelectedChatTab
} from '../agent-session/agent-session-tab-layout'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as ScheduleMobileSessionTabsChangedMethods } from './session-tabs-change-publication'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { restoredChatTabChanges } from './restored-chat-tab-changes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  admitStructuredSessionTabPublication,
  projectStructuredSessionTab,
  type StructuredSessionRawPublicationInput,
  type StructuredSessionTabPublicationInput
} from './structured-session-tab-publication'
import { OrcaRuntimeWithStructuredSessionLaunchRuntime } from './structured-session-launch-runtime'

export type AgentLaunchScope = Parameters<
  OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce['getAgentLaunchPlatformForWorkspace']
>[0]

export abstract class OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce extends OrcaRuntimeWithStructuredSessionLaunchRuntime {
  protected abstract notifyMobileSessionTabSnapshots(
    ...args: Parameters<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabSnapshots']>
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabSnapshots']>

  protected async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    if (host?.getPersistedVisibleSessionTabIndex?.().present !== true) {
      await host?.deps?.store?.initializeSessionTabs?.().catch((error: unknown) =>
        host.deps.logger.warn('recording restored chat tabs failed', {
          scope: 'tab-index-seed',
          error
        })
      )
    }
    await host?.seedSessionTabs()
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    // Every session here is of an agent this host registered: its store holds no other agent's records.
    const restored = (host?.listSessionTabs() ?? []).flatMap((session) => {
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      return [{ ...session, agent: session.agent, sessionId }]
    })
    const changes = restoredChatTabChanges(
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {},
      host,
      restored,
      (id) => this.hasCurrentLocalStructuredSessionTab(id)
    )
    for (const [worktreeId, worktreeChanges] of changes) {
      this.changeWindowlessChatTabs(worktreeId, worktreeChanges, (change) =>
        this.passiveStructuredSessionTabChangeEligible(change)
      )
    }
    for (const session of restored) {
      if (host?.isSessionTabVisible(session.sessionId)) {
        this.projectStructuredAgentSessionTab({ ...session, activate: false, notify: false })
      }
    }
    const wasUnverifiable = this.structuredAgentSessionInventoryUnverifiable
    // No host means no one can say which chats exist; with none on disk, empty is the answer.
    this.structuredAgentSessionInventoryUnverifiable =
      !host && this.hasPersistedStructuredAgentSessionStore()
    // This restore published quietly; subscribers still hold the frames that said "cannot tell".
    if (wasUnverifiable && !this.structuredAgentSessionInventoryUnverifiable) {
      this.notifyMobileSessionTabSnapshots()
    }
  }

  async publishStructuredAgentSessionTab(
    input: StructuredSessionTabPublicationInput
  ): Promise<void> {
    input.workspaceAuthority?.check()
    input.check?.()
    const { tabId, current, eligible } = await admitStructuredSessionTabPublication(input, () =>
      input.workspaceAuthority
        ? this.prepareStructuredAgentSessionStartupRestoration()
        : this.restoreStructuredAgentSessionTabs()
    )
    if (!eligible()) {
      throw new Error('Chat tab publication was superseded')
    }
    input.check?.()
    // A replace takes the selection only from a tab that still holds it, decided by the layout
    // owner as it writes: here for main's layout, else by the window applying the replace.
    let activate = input.activate
    let selectionDecided = false
    // The switch's source: the replaced tab, or the split pane's tab the chat opens beside.
    const source = input.replaces ?? input.sourceTabId
    const windowReplaces = Boolean(
      input.replaces && !ORCA_LAYOUT_OWNER_IS_MAIN && this.getAvailableAuthoritativeWindow()
    )
    if (input.check && (ORCA_LAYOUT_OWNER_IS_MAIN || !this.getAvailableAuthoritativeWindow())) {
      const check = input.check
      const applied = await this.queueChatTabChanges(
        () => {
          const session = this.getWorkspaceSessionForWorktree(input.workspaceId)
          if (source && session) {
            selectionDecided = true
            activate &&= savedTabHoldsSelection(
              this.getWorkspaceSessionHostIdForWorktree(input.workspaceId),
              session,
              input.workspaceId,
              source
            )
          }
          return [{ worktreeId: input.workspaceId, change: { open: { ...input, tabId } } }]
        },
        () => {
          check()
          return eligible()
        }
      )
      if (!applied) {
        throw new Error('tab_not_found')
      }
    } else if (!(ORCA_LAYOUT_OWNER_IS_MAIN && input.placedByWindow)) {
      // Window creates retain the window's own placement decision.
      const saving = this.saveWindowlessAgentSessionTab(input.workspaceId, {
        ...input,
        eligible,
        ...(tabId ? { tabId } : {})
      })
      input.workspaceAuthority?.saving(saving)
    }
    input.check?.()
    // The snapshot paired clients mirror says what this write decided, never the request's wish.
    this.projectStructuredAgentSessionTab({ ...input, tabId, eligible, activate, selectionDecided })
    input.workspaceAuthority?.committed()
    if (!eligible()) {
      throw new Error('Chat tab publication was superseded')
    }
    if (activate && input.check) {
      // The saved view selects the chat the switch put in the slot; the window draws from it.
      this.commitWindowlessChatSession(input.workspaceId, (session) =>
        withSelectedChatTab(
          this.getWorkspaceSessionHostIdForWorktree(input.workspaceId),
          session,
          input.workspaceId,
          input.sessionId
        )
      )
    }
    if (activate && !windowReplaces && input.focusWindow !== false && input.check) {
      this.notifier?.focusEditorTab?.(tabId, input.workspaceId, source)
    }
    input.capture?.({
      tableId: current ?? null,
      presentation: {
        raw: this.currentLocalStructuredSessionPresentation(input.sessionId),
        saved:
          ORCA_LAYOUT_OWNER_IS_MAIN && input.placedByWindow
            ? []
            : [{ worktreeId: input.workspaceId, tabId }]
      }
    })
  }

  /** The caller owns the store write; this publishes only its current raw surface. */
  projectStructuredAgentSessionTab(input: StructuredSessionRawPublicationInput): void {
    projectStructuredSessionTab(this, input, (snapshot) =>
      this.emitMobileSessionTabsSnapshot(snapshot)
    )
  }

  /** A startup's fact: the workspace it starts in, else the new worktree a create is making. */
}
