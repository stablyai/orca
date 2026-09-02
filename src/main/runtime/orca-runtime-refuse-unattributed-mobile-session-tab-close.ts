// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithApplyMobileSessionTabNavigation } from './orca-runtime-apply-mobile-session-tab-navigation'
import type { RuntimeMobileSessionTabCloseResult } from '../../shared/runtime-types'

export class OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose extends OrcaRuntimeWithApplyMobileSessionTabNavigation {
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
    // Why: a legacy client may already have hidden its mirror; a new snapshot
    // restores it without granting an unattributed request destructive authority.
    this.republishMobileSessionTabsSnapshot(snapshot.worktree)
    return {
      closed: true,
      refused: true,
      refusalReason: 'missing-intent',
      snapshotRepublished: true
    }
  }
}
