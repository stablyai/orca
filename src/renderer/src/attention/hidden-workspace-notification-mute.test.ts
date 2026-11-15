import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import { createTabsSliceMockApi } from '../store/slices/tabs/tabs-slice-test-harness'
import { createTestStore } from '../store/testing/app-store-test-fixture'
import { makeWorktree } from '../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../store/repos/repo.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const CLI_ID = 'repo1::/tmp/cli'
const PLAIN_ID = 'repo1::/tmp/plain'
const cliRow = makeWorktree({
  id: CLI_ID,
  repoId: 'repo1',
  path: '/tmp/cli',
  cliProvenance: { kind: 'created-by-cli', createdAt: 0 }
})
const plainRow = makeWorktree({ id: PLAIN_ID, repoId: 'repo1', path: '/tmp/plain' })

let store: ReturnType<typeof createTestStore>

function setNotifyHiddenWorkspaces(notifyHiddenWorkspaces: boolean): void {
  store.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      notifications: { ...getDefaultNotificationSettings(), notifyHiddenWorkspaces }
    }
  })
}

beforeEach(() => {
  store = createTestStore()
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [cliRow, plainRow] },
    persistedUIReady: true,
    workspaceSessionReady: true,
    hideCliCreatedWorkspaces: true
  })
  setNotifyHiddenWorkspaces(false)
})

describe('muted workspace attention', () => {
  it('writes no bell marker for a muted workspace, and still does for a visible one', () => {
    const terminalTab = (id: string, worktreeId: string) => ({
      id,
      ptyId: null,
      worktreeId,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    })
    store.setState({
      tabsByWorktree: {
        [CLI_ID]: [terminalTab('tab-cli', CLI_ID)],
        [PLAIN_ID]: [terminalTab('tab-plain', PLAIN_ID)]
      }
    })
    store
      .getState()
      .markTerminalBell({ worktreeId: CLI_ID, tabId: 'tab-cli', paneKey: 'tab-cli:0' })
    store
      .getState()
      .markTerminalBell({ worktreeId: PLAIN_ID, tabId: 'tab-plain', paneKey: 'tab-plain:0' })
    const rows = store.getState().worktreesByRepo.repo1
    expect(rows.find((row) => row.id === CLI_ID)?.isUnread).toBe(false)
    expect(store.getState().unreadTerminalTabs['tab-cli']).toBeUndefined()
    expect(rows.find((row) => row.id === PLAIN_ID)?.isUnread).toBe(true)
    expect(store.getState().unreadTerminalTabs['tab-plain']).toBe('terminal-bell')
  })
})
