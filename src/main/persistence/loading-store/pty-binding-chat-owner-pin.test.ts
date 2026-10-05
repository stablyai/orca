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
const tabId = 'chat-tab'
const source = { worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: 'source-pty' }

async function chatOnOnePane(hostId: string | undefined) {
  const harness = await fixture()
  const { store } = harness
  await store.persistPtyBinding({ ...source, incarnationId: 'source-incarnation' }, hostId)
  // A chat the single pane showed with no owner id (older hosts and launch stamps write this).
  const session = structuredClone(store.getWorkspaceSession(hostId))
  session.tabsByWorktree[worktreeId] = session.tabsByWorktree[worktreeId].map((tab) =>
    tab.id === tabId ? { ...tab, viewMode: 'chat' as const } : tab
  )
  store.setWorkspaceSession(session, hostId)
  await store.flushPendingOrThrowAsync()
  return harness
}

it.each([undefined, 'ssh:owner-pin'])(
  'pins the pre-split chat pane in the split admission itself, before the final split commit (%s)',
  async (hostId) => {
    const { store, readState } = await chatOnOnePane(hostId)

    // The headless split's PTY admission; the process stops before persistHeadlessTerminalSplit.
    expect(
      await store.persistPtyBinding(
        {
          worktreeId,
          tabId,
          leafId: TEST_LEAF_2,
          ptyId: 'split-pty',
          incarnationId: 'split-incarnation',
          hostAdmittedMembership: true,
          expectedSourceBinding: { ...source, incarnationId: 'source-incarnation' }
        },
        hostId
      )
    ).toBe(true)

    const durable = hostId
      ? readState().workspaceSessionsByHostId?.[hostId]
      : readState().workspaceSession
    expect(durable.terminalLayoutsByTabId[tabId]).toMatchObject({
      activeLeafId: TEST_LEAF_2,
      chatLeafId: TEST_LEAF_1
    })
    // Restore from exactly that state: chat stays on the agent's pane, never on the new shell.
    const rows = buildHeadlessMobileSessionTerminalTabs(
      worktreeId,
      durable.tabsByWorktree[worktreeId],
      durable
    ).filter((row) => row.parentTabId === tabId)
    expect(rows.map((row) => [row.leafId, row.viewMode, row.parentLayout?.chatLeafId])).toEqual([
      [TEST_LEAF_1, 'chat', TEST_LEAF_1],
      [TEST_LEAF_2, 'chat', TEST_LEAF_1]
    ])
  }
)

it('never pins a terminal tab when a pane is grafted', async () => {
  const { store } = await chatOnOnePane(undefined)
  const session = structuredClone(store.getWorkspaceSession())
  session.tabsByWorktree[worktreeId] = session.tabsByWorktree[worktreeId].map((tab) =>
    tab.id === tabId ? { ...tab, viewMode: 'terminal' as const } : tab
  )
  store.setWorkspaceSession(session)

  await store.persistPtyBinding({ worktreeId, tabId, leafId: TEST_LEAF_2, ptyId: 'split-pty' })

  expect(store.getWorkspaceSession().terminalLayoutsByTabId[tabId]?.chatLeafId).toBeUndefined()
})
