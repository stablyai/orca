// Windowless phone split moves and subsequent creates must retain main-owned groups/order.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
await import('../orca-runtime-test-mocks.spec')
await import('../orca-runtime-test-lifecycle.spec')
const { TEST_WORKTREE_ID, TEST_WORKTREE_PATH } = await import('../orca-runtime-test-fixtures.spec')
const { SURFACE_TAB_ID } = await import('../terminal/surface/terminal-surface-replies.test-fixture')
const { SAVED_GROUP_ID, SECOND_TAB_ID, THIRD_TAB_ID, tabStrip, threeTabSurfaceRuntime } =
  await import('./session-tabs-layout-moves.test-fixture')

const WORKTREE = `id:${TEST_WORKTREE_ID}`
const CHAT = 'agent-session:s1'

/** The three saved tabs on a server with no window, whose spawns bind their pane as the host's do. */
async function headlessRuntime() {
  const harness = threeTabSurfaceRuntime()
  const { runtime, bindPane } = harness
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  runtime.setPtyController({
    spawn: vi.fn(async (args: { worktreeId?: string; tabId?: string; leafId?: string }) => {
      await bindPane({
        worktreeId: args.worktreeId!,
        tabId: args.tabId!,
        leafId: args.leafId!,
        ptyId: 'pty-new'
      })
      return { id: 'pty-new' }
    }),
    write: () => true,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () =>
      ['pty-a', 'pty-b', 'pty-new'].map((id) => ({ id, cwd: TEST_WORKTREE_PATH, title: 'sh' }))
  })
  await runtime.listMobileSessionTabs(WORKTREE)
  return harness
}

const orderOf = (rows: readonly { type: string; id: string; parentTabId?: string }[]) => [
  ...new Set(rows.map((row) => (row.type === 'terminal' ? row.parentTabId! : row.id)))
]

describe("a phone's layout change on a windowless server (switch on)", () => {
  it("splits a tab into a group of its own in main's layout, and selects it there", async () => {
    const { runtime, store } = await headlessRuntime()

    await runtime.moveMobileSessionTab(WORKTREE, {
      kind: 'split',
      tabId: SECOND_TAB_ID,
      targetGroupId: SAVED_GROUP_ID,
      splitDirection: 'right'
    })

    const strip = [[SURFACE_TAB_ID, THIRD_TAB_ID], [SECOND_TAB_ID]]
    const listed = await runtime.listMobileSessionTabs(WORKTREE)
    expect(tabStrip(listed)).toEqual(strip)
    expect(listed.activeGroupId).toBe(listed.tabGroups?.[1]?.id)
    expect(listed.activeTabId?.startsWith(`${SECOND_TAB_ID}::`)).toBe(true)
    // Main's own layout holds the split, so every later write of the rows keeps it.
    expect(
      store.getSession().tabGroups?.[TEST_WORKTREE_ID]?.map((group) => group.tabOrder)
    ).toEqual(strip)
  })

  it("refuses a split of a row main's layout does not hold, sending nothing (#31925)", async () => {
    const { runtime } = await headlessRuntime()
    runtime.projectStructuredAgentSessionTab({
      workspaceId: TEST_WORKTREE_ID,
      sessionId: 's1',
      agent: 'claude',
      activate: false
    })
    const apply = vi.spyOn(runtime, 'applyLayoutCommand')

    await expect(
      runtime.moveMobileSessionTab(WORKTREE, {
        kind: 'split',
        tabId: CHAT,
        targetGroupId: SAVED_GROUP_ID,
        splitDirection: 'right'
      })
    ).rejects.toThrow('tab_not_found')

    expect(apply).not.toHaveBeenCalled()
    expect((await runtime.listMobileSessionTabs(WORKTREE)).tabs.map((row) => row.id)).toContain(
      CHAT
    )
  })

  it("sends nothing for a group's last tab dropped on its neighbour's facing edge", async () => {
    const { runtime } = await headlessRuntime()
    const split = { kind: 'split', tabId: SECOND_TAB_ID, targetGroupId: SAVED_GROUP_ID } as const
    await runtime.moveMobileSessionTab(WORKTREE, { ...split, splitDirection: 'right' })
    const apply = vi.spyOn(runtime, 'applyLayoutCommand')

    await runtime.moveMobileSessionTab(WORKTREE, { ...split, splitDirection: 'right' })

    expect(apply).not.toHaveBeenCalled()
  })

  it("answers a split main refuses with main's refusal code", async () => {
    const { runtime } = await headlessRuntime()
    vi.spyOn(runtime, 'applyLayoutCommand').mockResolvedValue({ ok: false, code: 'invalid_params' })

    await expect(
      runtime.moveMobileSessionTab(WORKTREE, {
        kind: 'split',
        tabId: SECOND_TAB_ID,
        targetGroupId: SAVED_GROUP_ID,
        splitDirection: 'right'
      })
    ).rejects.toThrow('invalid_params')
    expect(tabStrip(await runtime.listMobileSessionTabs(WORKTREE))).toEqual([
      [SURFACE_TAB_ID, SECOND_TAB_ID, THIRD_TAB_ID]
    ])
  })

  it.each([
    {
      client: 'a phone with split-group placement',
      supportsSplitGroupPlacement: true,
      order: (created: string) => [SURFACE_TAB_ID, created, SECOND_TAB_ID, THIRD_TAB_ID]
    },
    {
      client: 'an older phone, at the end as today',
      supportsSplitGroupPlacement: false,
      order: (created: string) => [SURFACE_TAB_ID, SECOND_TAB_ID, THIRD_TAB_ID, created]
    }
  ])('places a terminal $client creates after a split tab', async (testCase) => {
    const { runtime } = await headlessRuntime()
    const splitRow = (await runtime.listMobileSessionTabs(WORKTREE)).tabs.find(
      (row) => row.type === 'terminal' && row.parentTabId === SURFACE_TAB_ID
    )

    const created = await runtime.createMobileSessionTerminal(WORKTREE, {
      afterTabId: splitRow?.id,
      clientNavigationId: 'phone',
      supportsSplitGroupPlacement: testCase.supportsSplitGroupPlacement
    })

    const listed = await runtime.listMobileSessionTabs(WORKTREE)
    const order = testCase.order(created.tab.parentTabId)
    expect(tabStrip(listed)).toEqual([order])
    expect(orderOf(listed.tabs)).toEqual(order)
  })

  it("places a terminal created after a chat main holds in the chat's group, after it", async () => {
    const { runtime } = await headlessRuntime()
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: TEST_WORKTREE_ID,
      sessionId: 's1',
      agent: 'claude',
      activate: true
    })
    await runtime.moveMobileSessionTab(WORKTREE, {
      kind: 'split',
      tabId: CHAT,
      targetGroupId: SAVED_GROUP_ID,
      splitDirection: 'right'
    })

    const created = await runtime.createMobileSessionTerminal(WORKTREE, {
      afterTabId: CHAT,
      clientNavigationId: 'phone',
      supportsSplitGroupPlacement: true
    })

    expect(tabStrip(await runtime.listMobileSessionTabs(WORKTREE))).toEqual([
      [SURFACE_TAB_ID, SECOND_TAB_ID, THIRD_TAB_ID],
      [CHAT, created.tab.parentTabId]
    ])
  })
})
