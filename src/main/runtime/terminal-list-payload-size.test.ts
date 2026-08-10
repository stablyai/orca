import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

// Measures the real `terminal.list` wire payload for a large listing, so the
// visualLayouts opt-out keeps paying for itself. Sized against a live
// 134-terminal remote runtime (137,412 B on the wire, visualLayouts 44,208 B).
const TERMINAL_COUNT = 134
const PANES_PER_TAB = 2
const TAB_COUNT = TERMINAL_COUNT / PANES_PER_TAB
// Leaves ~19% headroom over the measured 75,467 B while catching material bloat.
const MAX_OPTED_OUT_PAYLOAD_BYTES = 90_000
const REPO_ID = 'repo-7f3a91c2e4b85d60'
const WORKTREE_PATH = '/Users/dev/orca/workspaces/orca/perf-terminal-list-diet'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const uuid = (n: number): string => {
  const hex = n.toString(16).padStart(12, '0')
  return `11111111-1111-4111-8111-${hex}`
}

const leafIdFor = (index: number): string => uuid(index)
const tabIdFor = (tab: number): string => `tab-${uuid(1_000 + tab)}`
const ptyIdFor = (index: number): string => `pty-${uuid(2_000 + index)}`
const groupIdFor = (tab: number): string => `group-${uuid(3_000 + (tab % 2))}`
const titleFor = (index: number): string => `claude — orca/perf-terminal-list-diet #${index}`

const makeStore = () => ({
  getRepo: (id: string) => makeStore().getRepos()[0] ?? (id as never),
  getRepos: () => [
    { id: REPO_ID, path: '/tmp/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
  ],
  addRepo: () => {},
  updateRepo: (id: string) => makeStore().getRepo(id) as never,
  getAllWorktreeMeta: () => ({
    [WORKTREE_ID]: {
      displayName: 'foo',
      comment: '',
      linkedIssue: 123,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }),
  getWorktreeMeta: (worktreeId: string) =>
    (makeStore().getAllWorktreeMeta() as Record<string, unknown>)[worktreeId] as never,
  setWorktreeMeta: () => ({}) as never,
  removeWorktreeMeta: () => {},
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
})

type PaneLayout =
  | { type: 'leaf'; leafId: string }
  | { type: 'split'; direction: 'vertical'; first: PaneLayout; second: PaneLayout }

type GraphTab = {
  tabId: string
  worktreeId: string
  title: string
  activeLeafId: string
  layout: PaneLayout
}

type GraphLeaf = {
  tabId: string
  worktreeId: string
  leafId: string
  paneRuntimeId: number
  ptyId: string
  title: string
}

type MobileTab = {
  type: 'terminal'
  id: string
  title: string
  parentTabId: string
  leafId: string
  ptyId: string
  parentLayout: {
    root: PaneLayout
    activeLeafId: string
    expandedLeafId: string | null
    ptyIdsByLeafId: Record<string, string>
  }
  isActive: boolean
}

function buildLoadedRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const tabs: GraphTab[] = []
  const leaves: GraphLeaf[] = []
  const mobileTabs: MobileTab[] = []

  for (let tab = 0; tab < TAB_COUNT; tab += 1) {
    const tabId = tabIdFor(tab)
    const first = leafIdFor(tab * PANES_PER_TAB)
    const second = leafIdFor(tab * PANES_PER_TAB + 1)
    const root: PaneLayout = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: first },
      second: { type: 'leaf', leafId: second }
    }
    tabs.push({
      tabId,
      worktreeId: WORKTREE_ID,
      title: `Tab ${tab}`,
      activeLeafId: second,
      layout: root
    })
    for (let pane = 0; pane < PANES_PER_TAB; pane += 1) {
      const index = tab * PANES_PER_TAB + pane
      const leafId = leafIdFor(index)
      leaves.push({
        tabId,
        worktreeId: WORKTREE_ID,
        leafId,
        paneRuntimeId: pane + 1,
        ptyId: ptyIdFor(index),
        title: titleFor(index)
      })
      mobileTabs.push({
        type: 'terminal',
        id: `${tabId}::${leafId}`,
        title: titleFor(index),
        parentTabId: tabId,
        leafId,
        ptyId: ptyIdFor(index),
        parentLayout: {
          root,
          activeLeafId: second,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [first]: ptyIdFor(tab * PANES_PER_TAB),
            [second]: ptyIdFor(tab * PANES_PER_TAB + 1)
          }
        },
        isActive: index === 0
      })
    }
  }

  const groupIds = [groupIdFor(0), groupIdFor(1)]
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs,
    leaves,
    mobileSessionTabs: [
      {
        worktree: WORKTREE_ID,
        publicationEpoch: 'test',
        snapshotVersion: 1,
        activeGroupId: groupIds[0],
        activeTabId: mobileTabs[0]!.id,
        activeTabType: 'terminal',
        tabGroups: groupIds.map((id, groupIndex) => ({
          id,
          activeTabId: tabIdFor(groupIndex),
          tabOrder: tabs
            .filter((_tab, tabIndex) => tabIndex % 2 === groupIndex)
            .map((tab) => tab.tabId)
        })),
        tabGroupLayout: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: groupIds[0] },
          second: { type: 'leaf', groupId: groupIds[1] }
        },
        tabs: mobileTabs
      }
    ]
  } as never)

  // Realistic previews: the live sample carried ~27 B of tail text per terminal.
  for (let index = 0; index < TERMINAL_COUNT; index += 1) {
    const ptyId = ptyIdFor(index)
    runtime.registerPty(ptyId, WORKTREE_ID)
    runtime.onPtySpawned(ptyId, `inc-${uuid(4_000 + index)}`, { awaitsRegistration: false })
    runtime.onPtyData(ptyId, `esc to interrupt · ${index}\n`, 1)
  }
  return runtime
}

describe('terminal.list payload size', () => {
  it('drops ~30% of the wire payload when a caller opts out of visualLayouts', async () => {
    const runtime = buildLoadedRuntime()

    const withLayouts = await runtime.listTerminals(`id:${WORKTREE_ID}`, 10_000)
    const layoutBuilder = vi.fn(() => [])
    Object.defineProperty(runtime, 'buildTerminalVisualLayouts', { value: layoutBuilder })
    const withoutLayouts = await runtime.listTerminals(`id:${WORKTREE_ID}`, 10_000, {
      includeVisualLayouts: false
    })
    const { visualLayouts, ...expectedWithoutLayouts } = withLayouts

    expect(withLayouts.terminals).toHaveLength(TERMINAL_COUNT)
    expect(visualLayouts).toHaveLength(1)
    expect(withoutLayouts).toEqual(expectedWithoutLayouts)
    expect(layoutBuilder).not.toHaveBeenCalled()

    const beforeBytes = Buffer.byteLength(JSON.stringify(withLayouts), 'utf8')
    const afterBytes = Buffer.byteLength(JSON.stringify(withoutLayouts), 'utf8')
    const layoutBytes = Buffer.byteLength(JSON.stringify(withLayouts.visualLayouts), 'utf8')
    const reduction = (beforeBytes - afterBytes) / beforeBytes

    console.log(
      `terminal.list ${TERMINAL_COUNT} terminals: ${beforeBytes} B -> ${afterBytes} B ` +
        `(-${(reduction * 100).toFixed(1)}%); visualLayouts alone ${layoutBytes} B`
    )

    expect(beforeBytes).toBeGreaterThan(100_000)
    expect(afterBytes).toBeLessThanOrEqual(MAX_OPTED_OUT_PAYLOAD_BYTES)
    expect(reduction).toBeGreaterThan(0.25)
  })
})
