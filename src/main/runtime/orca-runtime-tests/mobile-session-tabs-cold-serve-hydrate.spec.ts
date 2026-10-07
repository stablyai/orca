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
      tabGroups: {
        [TEST_WORKTREE_ID]: [
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
      }
    })

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabGroups?.map((group) => group.tabOrder)).toEqual([
      ['serve-tab'],
      ['daemon-tab']
    ])
  })
})
