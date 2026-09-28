import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'

const WORKTREE_ID = 'repo::/worktree'

function crossGroupSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'host',
    snapshotVersion: 4,
    activeGroupId: 'b-group',
    activeTabId: 'b-closing::left',
    activeTabType: 'terminal',
    // Visit order: b-old, then a-new (a cross-group visit), then b-closing.
    recentTabIds: ['b-old', 'a-new', 'b-closing'],
    tabGroups: [
      {
        id: 'a-group',
        activeTabId: 'a-new',
        tabOrder: ['a-new'],
        recentTabIds: ['a-new']
      },
      {
        id: 'b-group',
        activeTabId: 'b-closing',
        tabOrder: ['b-old', 'b-closing'],
        recentTabIds: ['b-old', 'b-closing']
      }
    ],
    tabs: [
      {
        type: 'markdown',
        id: 'a-new',
        title: 'A New',
        filePath: '/worktree/new.md',
        relativePath: 'new.md',
        language: 'markdown',
        mode: 'edit',
        isDirty: false,
        sourceFileId: 'new.md',
        sourceFilePath: '/worktree/new.md',
        sourceRelativePath: 'new.md',
        documentVersion: '1',
        isActive: false
      },
      {
        type: 'file',
        id: 'b-old',
        title: 'B Old',
        filePath: '/worktree/old.ts',
        relativePath: 'old.ts',
        language: 'typescript',
        isDirty: false,
        isActive: false
      },
      {
        type: 'terminal',
        id: 'b-closing::left',
        parentTabId: 'b-closing',
        leafId: 'left',
        ptyId: 'pty-b-closing',
        title: 'B Closing',
        parentLayout: {
          root: { type: 'leaf' as const, leafId: 'left' },
          activeLeafId: 'left',
          expandedLeafId: null,
          ptyIdsByLeafId: { left: 'pty-b-closing' },
          buffersByLeafId: { left: 'b buffer' },
          titlesByLeafId: { left: 'B Closing' }
        },
        isActive: true
      }
    ]
  }
}

function createRuntimeHarness() {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    undefined
  )
  const stored: RuntimeMobileSessionTabsSnapshot[] = []
  Object.assign(runtime, {
    getMobileSessionTerminalRetirementProof: vi.fn(() => null),
    commitHeadlessTerminalTabRetirement: vi.fn(() => [] as string[]),
    clearRuntimeSessionOwnershipForMobileTab: vi.fn(),
    getMobileTerminalLeafPtyIds: vi.fn(() => [] as string[]),
    findPtyForMobileTerminalTab: vi.fn(() => undefined),
    closeTerminalSurface: vi.fn(async () => [] as string[]),
    captureTerminalTabRetirement: vi.fn(() => () => ({ matches: true })),
    mobileSessionTabsByWorktree: new Map<string, RuntimeMobileSessionTabsSnapshot>(),
    storeMobileSessionSnapshot: vi.fn(
      (_worktree: string, snapshot: RuntimeMobileSessionTabsSnapshot) => {
        stored.push(snapshot)
        return snapshot
      }
    ),
    emitMobileSessionTabsSnapshot: vi.fn()
  })
  return { runtime, stored }
}

// Why: closing the active tab must fall back to the globally most recently viewed
// remaining tab. The per-group MRU merge below would surface b-old (its group's
// stack is merged last), even though a-new was visited after it.
describe('closeHeadlessMobileTerminalTab successor selection', () => {
  it('follows the global visit history across groups, not the group-merged order', async () => {
    const { runtime, stored } = createRuntimeHarness()
    const snapshot = crossGroupSnapshot()
    const closedTab = snapshot.tabs.find(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.id === 'b-closing::left'
    )!

    await (
      runtime as unknown as {
        closeHeadlessMobileTerminalTab: (
          worktreeId: string,
          snapshot: RuntimeMobileSessionTabsSnapshot,
          tab: RuntimeMobileSessionTerminalTab,
          options?: { killPtys?: boolean }
        ) => Promise<void>
      }
    ).closeHeadlessMobileTerminalTab(WORKTREE_ID, snapshot, closedTab, { killPtys: false })

    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ activeTabId: 'a-new', activeTabType: 'markdown' })
    expect(stored[0].recentTabIds).toEqual(['b-old', 'a-new'])
  })

  it('falls back to the group history when every global history id is gone', async () => {
    const { runtime, stored } = createRuntimeHarness()
    const snapshot = crossGroupSnapshot()
    // Every global history entry is either stale or the closing tab, so the
    // filtered history is empty and the group history must supply the successor.
    snapshot.recentTabIds = ['gone-stale', 'b-closing']
    // x-last is the last-added remaining tab; only the group history can prefer b-old.
    snapshot.tabs.push({
      type: 'file',
      id: 'x-last',
      title: 'X Last',
      filePath: '/worktree/x.ts',
      relativePath: 'x.ts',
      language: 'typescript',
      isDirty: false,
      isActive: false
    })
    const closedTab = snapshot.tabs.find(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.id === 'b-closing::left'
    )!

    await (
      runtime as unknown as {
        closeHeadlessMobileTerminalTab: (
          worktreeId: string,
          snapshot: RuntimeMobileSessionTabsSnapshot,
          tab: RuntimeMobileSessionTerminalTab,
          options?: { killPtys?: boolean }
        ) => Promise<void>
      }
    ).closeHeadlessMobileTerminalTab(WORKTREE_ID, snapshot, closedTab, { killPtys: false })

    expect(stored).toHaveLength(1)
    // b-old is the most recent surviving group-history tab; the last-added tab
    // x-last must not win just because the global history filtered to empty.
    expect(stored[0]).toMatchObject({ activeTabId: 'b-old' })
    // Stale history must be cleared instead of carried over into the snapshot.
    expect(stored[0].recentTabIds).toBeUndefined()
  })
})
