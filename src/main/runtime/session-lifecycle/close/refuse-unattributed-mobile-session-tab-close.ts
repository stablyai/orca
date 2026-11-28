import { OrcaRuntimeWithMcpStaleTerminals } from '../projection/mcp-stale-terminal-restart'
import { isTeammateTabList, type TabPerson } from '../../../bots/team-share/teammate-rules'
import type {
  RuntimeMobileSessionTabCloseResult,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/** The list a close names, resolved once (`sessionTabCloseTarget`): a watched list's person's, or the
 *  caller's own on their device. */
export type SessionTabCloseTarget = {
  person: TabPerson
  clientNavigationId?: string
  /** Another person's list, which the closer watches: nothing of the closer's moves. */
  watched: boolean
  list: () => Promise<RuntimeMobileSessionTabsResult>
}

export abstract class OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose extends OrcaRuntimeWithMcpStaleTerminals {
  async refuseUnattributedMobileSessionTabClose(
    tabId: string,
    caller: SessionTabCloseTarget
  ): Promise<RuntimeMobileSessionTabCloseResult> {
    const { clientNavigationId } = caller
    const snapshot = await caller.list()
    const tabExists = snapshot.tabs.some(
      (candidate) =>
        candidate.id === tabId ||
        (candidate.type === 'terminal' && candidate.parentTabId === tabId) ||
        (candidate.type === 'browser' && candidate.browserWorkspaceId === tabId)
    )
    if (!tabExists) {
      throw new Error('tab_not_found')
    }
    const refused = {
      closed: true as const,
      refused: true as const,
      refusalReason: 'missing-intent' as const
    }
    // A watched list is refused as it is: its person's devices and the host never hear of it.
    if (caller.watched) {
      return refused
    }
    // Legacy clients may hide their mirror first; republish it without authorizing an unattributed destructive close.
    const list = this.homeTabListOf(caller.person, snapshot.worktree)
    if (isTeammateTabList(list)) {
      // Their own workspace's frame, as their devices read it: the Home's id, their pick.
      const own =
        clientNavigationId &&
        this.ownSessionTabListFrame(snapshot.worktree, clientNavigationId, false, true)
      if (own) {
        this.emitMobileSessionTabsSnapshotToClient(own, clientNavigationId)
      }
    } else {
      this.republishMobileSessionTabsSnapshot(snapshot.worktree)
    }
    return { ...refused, snapshotRepublished: true as const }
  }
}
