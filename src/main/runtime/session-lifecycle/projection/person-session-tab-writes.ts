// Writing a teammate's own chat tabs: the one rule that keeps a teammate's tab in the agent's home out
// of the host's list, and telling every device of theirs when their tab set changes.
import { getActiveRpcCaller } from '../../rpc/callers/active-call'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredSessionTabPublicationInput } from '../../session-tabs/chat/structured-session-tab-publication'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as MobileSessionPublication } from '../../session-tabs/publication/session-tabs-change-publication'
import { OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh } from './perform-mobile-session-pty-records-refresh'

export abstract class OrcaRuntimeWithPersonSessionTabWrites extends OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh {
  protected abstract createMobileSessionTabsDelivery(): ReturnType<
    MobileSessionPublication['createMobileSessionTabsDelivery']
  >

  /** Closes a tab from the caller's person's own tabs; false when it is not one of theirs. */
  protected closePersonSessionTab(
    worktreeId: string,
    tabId: string,
    clientNavigationId: string | undefined
  ): boolean {
    const closed =
      clientNavigationId !== undefined &&
      this.clientSessionTabSelections.personTabs.close(clientNavigationId, worktreeId, tabId)
    if (closed) {
      void this.publishPersonSessionTabs(worktreeId)
    }
    return closed
  }

  /** The one tab-write rule for a chat: a teammate's tab in the agent's home is theirs alone, never
   *  in the host's list, which is the owner's screens'. False when the tab is the host's to publish. */
  protected async publishTeammateSessionTab(
    input: StructuredSessionTabPublicationInput
  ): Promise<boolean> {
    const caller = getActiveRpcCaller()
    if (
      caller?.kind !== 'paired-device' ||
      !this.clientSessionTabSelections.personTabs.open(
        caller.deviceId,
        input.workspaceId,
        input.sessionId
      )
    ) {
      return false
    }
    const host = getStructuredAgentSessionHost()
    // A create founds a host tab row; the chat stays open with none, as a teammate's chat does.
    if (host?.getSessionTabId(input.sessionId)) {
      await host.setSessionTabVisibility(input.sessionId, false, undefined, { background: true })
    }
    input.workspaceAuthority?.committed()
    input.capture?.({
      tableId: null,
      presentation: {
        raw: this.currentLocalStructuredSessionPresentation(input.sessionId),
        saved: []
      }
    })
    await this.publishPersonSessionTabs(input.workspaceId)
    return true
  }

  /** A person's own tabs changed: every listener re-projects, so each device of theirs redraws. */
  async publishPersonSessionTabs(worktreeId: string): Promise<void> {
    this.createMobileSessionTabsDelivery()(
      await this.getMobileSessionTabsForWorktree(worktreeId, undefined, {
        includeAgentSenders: false
      }),
      ++this.mobileSessionTabsChangeSequence
    )
  }
}
