import { OrcaRuntimeWithMcpStaleTerminals } from '../projection/mcp-stale-terminal-restart'
import { isTeammateTabList, type TabPerson } from '../../../bots/team-share/teammate-rules'
import type { RuntimeMobileSessionTabCloseResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

export abstract class OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose extends OrcaRuntimeWithMcpStaleTerminals {
  async refuseUnattributedMobileSessionTabClose(
    worktreeSelector: string,
    tabId: string,
    caller: { person: TabPerson; clientNavigationId?: string }
  ): Promise<RuntimeMobileSessionTabCloseResult> {
    const { clientNavigationId } = caller
    // The caller's own list: a teammate's in their Home, the host's anywhere else.
    const snapshot = await this.listMobileSessionTabs(worktreeSelector, clientNavigationId, {
      includeAgentSenders: false
    })
    const tabExists = snapshot.tabs.some(
      (candidate) =>
        candidate.id === tabId ||
        (candidate.type === 'terminal' && candidate.parentTabId === tabId) ||
        (candidate.type === 'browser' && candidate.browserWorkspaceId === tabId)
    )
    if (!tabExists) {
      throw new Error('tab_not_found')
    }
    // Legacy clients may hide their mirror first; republish it without authorizing an unattributed destructive close.
    const list = this.homeTabListOf(caller.person, snapshot.worktree)
    if (isTeammateTabList(list)) {
      if (clientNavigationId) {
        this.emitMobileSessionTabsSnapshotToClient(
          this.projectMobileSessionTabsForClient(
            this.personSessionTabsFrame(list, snapshot.worktree),
            clientNavigationId
          ),
          clientNavigationId
        )
      }
    } else {
      this.republishMobileSessionTabsSnapshot(snapshot.worktree)
    }
    return {
      closed: true,
      refused: true,
      refusalReason: 'missing-intent',
      snapshotRepublished: true
    }
  }
}
