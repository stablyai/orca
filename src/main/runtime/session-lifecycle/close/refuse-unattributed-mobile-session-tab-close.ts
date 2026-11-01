import { OrcaRuntimeWithResumeAgentSessionInWorkspace } from '../projection/resume-agent-session-in-workspace'
import type { RuntimeMobileSessionTabCloseResult } from '../../../../shared/runtime-types'

export abstract class OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose extends OrcaRuntimeWithResumeAgentSessionInWorkspace {
  async refuseUnattributedMobileSessionTabClose(
    worktreeSelector: string,
    tabId: string
  ): Promise<RuntimeMobileSessionTabCloseResult> {
    const snapshot = await this.listMobileSessionTabs(worktreeSelector)
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
    this.republishMobileSessionTabsSnapshot(snapshot.worktree)
    return {
      closed: true,
      refused: true,
      refusalReason: 'missing-intent',
      snapshotRepublished: true
    }
  }
}
