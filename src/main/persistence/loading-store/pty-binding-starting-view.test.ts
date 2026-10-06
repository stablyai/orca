import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { buildHeadlessMobileSessionTerminalTabs } from '../../runtime/mobile-session-terminal-projection'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const worktreeId = 'repo-local::/fixture/local'
const tabId = 'agent-tab'

it.each([
  ['chat', undefined],
  ['chat', 'ssh:starting-view'],
  ['terminal', undefined],
  ['terminal', 'ssh:starting-view']
] as const)(
  'writes the launch starting view (%s) in the fresh tab admission itself (%s)',
  async (startingViewMode, hostId) => {
    const { store, readState } = await fixture()

    // The host launch's PTY admission; the process stops before any reveal or snapshot.
    expect(
      await store.persistPtyBinding(
        {
          worktreeId,
          tabId,
          leafId: TEST_LEAF_1,
          ptyId: 'agent-pty',
          incarnationId: 'agent-incarnation',
          hostAdmittedMembership: true,
          startingViewMode
        },
        hostId
      )
    ).toBe(true)

    const durable = hostId
      ? readState().workspaceSessionsByHostId?.[hostId]
      : readState().workspaceSession
    const row = durable.tabsByWorktree[worktreeId].find((tab: { id: string }) => tab.id === tabId)
    expect(row?.viewMode).toBe(startingViewMode)
    expect(durable.terminalLayoutsByTabId[tabId].chatLeafId).toBe(
      startingViewMode === 'chat' ? TEST_LEAF_1 : undefined
    )
    // Restore from exactly that state: the tab reopens in the launch's view on its own pane.
    const rows = buildHeadlessMobileSessionTerminalTabs(
      worktreeId,
      durable.tabsByWorktree[worktreeId],
      durable
    ).filter((projected) => projected.parentTabId === tabId)
    expect(rows.map((row) => [row.leafId, row.viewMode, row.parentLayout?.chatLeafId])).toEqual([
      [TEST_LEAF_1, startingViewMode, startingViewMode === 'chat' ? TEST_LEAF_1 : undefined]
    ])
  }
)

it('never re-stamps a tab that already exists: an adopted unswitched tab stays unswitched', async () => {
  const { store } = await fixture()
  await store.persistPtyBinding({ worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: 'old-pty' })

  // A later launch into that tab (a new pane, or a relaunch) carries a starting view.
  await store.persistPtyBinding({
    worktreeId,
    tabId,
    leafId: TEST_LEAF_2,
    ptyId: 'new-pty',
    hostAdmittedMembership: true,
    startingViewMode: 'chat'
  })

  const session = store.getWorkspaceSession()
  expect(session.tabsByWorktree[worktreeId].find((tab) => tab.id === tabId)?.viewMode).toBe(
    undefined
  )
  expect(session.terminalLayoutsByTabId[tabId].chatLeafId).toBeUndefined()
})
