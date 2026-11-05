import type { OrcaRuntimeService } from '../../orca-runtime'

export function visibleSnapshot() {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal' as const,
    tabGroups: [{ id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] }],
    tabs: [
      {
        type: 'terminal' as const,
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: 'Terminal',
        status: 'ready' as const,
        terminal: 'pty-1',
        isActive: true
      }
    ]
  }
}

/** These stream fixtures start before their first separately numbered change. */
export const sessionTabsSequencedReadFixture = {
  async listMobileSessionTabsWithChangeSequence(
    this: Pick<OrcaRuntimeService, 'listMobileSessionTabs'>,
    ...args: Parameters<OrcaRuntimeService['listMobileSessionTabs']>
  ) {
    return { snapshot: await this.listMobileSessionTabs(...args), changeSequence: 0 }
  }
}
