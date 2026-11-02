import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

const SERVE_PTY_ID = 'serve-mobile-created-pty'
const DAEMON_PTY_ID = 'daemon-agent-launch-pty'

function makeTerminalTab(id: string, ptyId: string, sortOrder: number) {
  return {
    id,
    ptyId,
    worktreeId: TEST_WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

// A serve host's persisted session after restart: one phone-created (serve-) terminal and one
// launched through terminal.create (daemon id), with nothing rebuilt in memory yet.
function makeRestartedServeRuntime(overrides: Partial<WorkspaceSessionState> = {}) {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeTabId: 'serve-tab',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'serve-tab' },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          makeTerminalTab('serve-tab', SERVE_PTY_ID, 0),
          makeTerminalTab('daemon-tab', DAEMON_PTY_ID, 1)
        ]
      },
      terminalLayoutsByTabId: {
        'serve-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: SERVE_PTY_ID }),
        'daemon-tab': makeHeadlessTerminalLayout({ [HEADLESS_SECOND_LEAF_ID]: DAEMON_PTY_ID })
      },
      ...overrides
    })
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'unexpected-pty' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  return runtime
}

const SPLIT_GROUPS = [
  {
    id: 'group-left',
    worktreeId: TEST_WORKTREE_ID,
    activeTabId: 'serve-tab',
    tabOrder: ['serve-tab']
  },
  {
    id: 'group-right',
    worktreeId: TEST_WORKTREE_ID,
    activeTabId: 'daemon-tab',
    tabOrder: ['daemon-tab']
  }
]

// Why: the per-client list projection repairs activeGroupId, so read the host's stored snapshot.
function storedActiveGroupId(runtime: OrcaRuntimeService): string | null | undefined {
  const snapshots: Map<string, { activeGroupId?: string | null }> =
    runtime['mobileSessionTabsByWorktree']
  return snapshots.get(TEST_WORKTREE_ID)?.activeGroupId
}

function terminalPtyIds(tabs: readonly { type: string; ptyId?: string | null }[]): string[] {
  return tabs.flatMap((tab) => (tab.type === 'terminal' && tab.ptyId ? [tab.ptyId] : [])).sort()
}

describe('OrcaRuntimeService', () => {
  it('lists every persisted terminal of a windowless host after a cold restart', async () => {
    const runtime = makeRestartedServeRuntime()

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(terminalPtyIds(listed.tabs)).toEqual([DAEMON_PTY_ID, SERVE_PTY_ID].sort())
  })

  it('lists every persisted terminal in the all-worktrees inventory after a cold restart', async () => {
    const runtime = makeRestartedServeRuntime()

    const snapshots = await runtime.listAllMobileSessionTabs()
    const listed = snapshots.find((snapshot) => snapshot.worktree === TEST_WORKTREE_ID)

    expect(terminalPtyIds(listed?.tabs ?? [])).toEqual([DAEMON_PTY_ID, SERVE_PTY_ID].sort())
  })

  it('lists persisted editor tabs beside the terminals after a cold restart', async () => {
    const runtime = makeRestartedServeRuntime({
      openFilesByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            worktreeId: TEST_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      }
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(terminalPtyIds(listed.tabs)).toEqual([DAEMON_PTY_ID, SERVE_PTY_ID].sort())
    expect(listed.tabs.filter((tab) => tab.type === 'markdown').map((tab) => tab.id)).toEqual([
      '/repo/README.md'
    ])
  })

  it('restores a persisted split group layout on the cold rebuild', async () => {
    const runtime = makeRestartedServeRuntime({
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-left' },
      tabGroups: { [TEST_WORKTREE_ID]: SPLIT_GROUPS }
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabGroups?.map((group) => group.tabOrder)).toEqual([
      ['serve-tab'],
      ['daemon-tab']
    ])
    expect(storedActiveGroupId(runtime)).toBe('group-left')
  })

  it('restores the saved active group of a split even when it is not the first group', async () => {
    const runtime = makeRestartedServeRuntime({
      activeTabId: 'daemon-tab',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'daemon-tab' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-right' },
      tabGroups: { [TEST_WORKTREE_ID]: SPLIT_GROUPS }
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(storedActiveGroupId(runtime)).toBe('group-right')
    expect(listed.activeGroupId).toBe('group-right')
  })

  it('falls back to the active tab group when the saved active group was not restored', async () => {
    const runtime = makeRestartedServeRuntime({
      activeTabId: 'daemon-tab',
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'daemon-tab' },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-gone' },
      tabGroups: { [TEST_WORKTREE_ID]: SPLIT_GROUPS }
    })

    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(storedActiveGroupId(runtime)).toBe('group-right')
  })

  it('keeps the headless group active when there is no persisted split', async () => {
    const runtime = makeRestartedServeRuntime({
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-gone' }
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabGroups).toHaveLength(1)
    expect(storedActiveGroupId(runtime)).toBe(listed.tabGroups?.[0]?.id)
  })

  it('keeps phone and CLI creates in the group they joined across a cold restart', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeTabId: 'serve-tab',
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'serve-tab' },
        activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-left' },
        tabGroups: { [TEST_WORKTREE_ID]: SPLIT_GROUPS },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            makeTerminalTab('serve-tab', SERVE_PTY_ID, 0),
            makeTerminalTab('daemon-tab', DAEMON_PTY_ID, 1)
          ]
        },
        terminalLayoutsByTabId: {
          'serve-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: SERVE_PTY_ID }),
          'daemon-tab': makeHeadlessTerminalLayout({ [HEADLESS_SECOND_LEAF_ID]: DAEMON_PTY_ID })
        }
      })
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    let ptys = 0
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `created-pty-${++ptys}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    // The phone targets the right group; an untargeted CLI create joins the first, as on main.
    const phone = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      targetGroupId: 'group-right'
    })
    const cli = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`)
    const tabOrderOf = (session: WorkspaceSessionState, groupId: string) =>
      session.tabGroups?.[TEST_WORKTREE_ID]?.find((group) => group.id === groupId)?.tabOrder
    expect(tabOrderOf(getSession(), 'group-right')).toContain(phone.tab.parentTabId)
    expect(tabOrderOf(getSession(), 'group-left')).toContain(cli.tabId)

    const restarted = new OrcaRuntimeService(
      makeRuntimeStoreWithWorkspaceSession(getSession()).runtimeStore
    )
    const listed = await restarted.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabGroups?.map((group) => group.tabOrder)).toEqual([
      ['serve-tab', cli.tabId],
      ['daemon-tab', phone.tab.parentTabId]
    ])
  })
})
