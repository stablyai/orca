import { afterEach, expect, it, vi } from 'vitest'
import {
  ACK_INCARNATION,
  ACK_LEAF,
  ACK_SECOND_LEAF,
  ACK_TAB,
  ACK_WORKTREE,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'

const fixtures: ReturnType<typeof createAcknowledgedTabRetirementFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
  vi.restoreAllMocks()
})
function fixture(bound = false) {
  const result = createAcknowledgedTabRetirementFixture(bound)
  fixtures.push(result)
  return result
}

it.each([false, true])(
  'durably retires an acknowledged row with graph-before-ack=%s',
  async (graphBeforeAck) => {
    const f = fixture()
    const pending = f.close()
    await f.entered.promise
    expect(f.hasTab()).toBe(true)
    if (graphBeforeAck) {
      f.publish(false, 2)
    }
    f.acknowledgement.resolve()
    await expect(pending).resolves.toEqual({ closed: true })
    expect(f.hasTab()).toBe(false)
  }
)

it.each(['createdAt', 'generation'] as const)(
  'protects a same-ID replacement with newer %s',
  async (field) => {
    const f = fixture()
    const pending = f.close()
    await f.entered.promise
    const session = f.store.getWorkspaceSession()
    f.store.setWorkspaceSession(
      advanceTerminalTopologyRevision(
        {
          ...session,
          tabsByWorktree: {
            ...session.tabsByWorktree,
            [ACK_WORKTREE]: session.tabsByWorktree[ACK_WORKTREE].map((tab) => ({
              ...tab,
              [field]: 2
            }))
          }
        },
        ACK_WORKTREE
      )
    )
    f.acknowledgement.resolve()
    await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
    expect(f.hasTab()).toBe(true)
  }
)

it.each([false, true])(
  'finishes physical split exit with remote-session promotion=%s',
  async (remoteSession) => {
    const f = fixture(true)
    if (remoteSession) {
      f.store.setWorkspaceSession({
        ...f.store.getWorkspaceSession(),
        remoteSessionIdsByTabId: { [ACK_TAB]: 'pty-a' }
      })
    }
    const pending = f.close()
    await f.entered.promise
    f.runtime.onPtyExit('pty-a', 0, ACK_INCARNATION, { providerExitObserved: true })
    expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[ACK_TAB].ptyIdsByLeafId).toEqual({
      [ACK_SECOND_LEAF]: 'pty-b'
    })
    f.acknowledgement.resolve()
    await expect(pending).resolves.toEqual({ closed: true })
    expect(f.hasTab()).toBe(false)
  }
)

it('protects a new incarnation admitted after the old snapshot disappeared', async () => {
  const f = fixture(true)
  const pending = f.close()
  await f.entered.promise
  f.publish(false, 2)
  f.runtime.onPtySpawned('pty-a', '66666666-6666-4666-8666-666666666666')
  f.acknowledgement.resolve()
  await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  expect(f.hasTab()).toBe(true)
})

it('protects a persisted incarnation replacement on the same leaf and raw PTY ID', async () => {
  const f = fixture(true)
  const pending = f.close()
  await f.entered.promise
  f.store.persistPtyBinding({
    worktreeId: ACK_WORKTREE,
    tabId: ACK_TAB,
    leafId: ACK_LEAF,
    ptyId: 'pty-a',
    incarnationId: '66666666-6666-4666-8666-666666666666'
  })
  f.acknowledgement.resolve()
  await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  expect(f.hasTab()).toBe(true)
})

it('rechecks current pins after renderer acknowledgement', async () => {
  const f = fixture()
  const pending = f.close()
  await f.entered.promise
  const session = f.store.getWorkspaceSession()
  f.store.setWorkspaceSession({
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [ACK_WORKTREE]: session.tabsByWorktree[ACK_WORKTREE].map((tab) => ({
        ...tab,
        isPinned: true
      }))
    }
  })
  f.acknowledgement.resolve()
  await expect(pending).rejects.toThrow('terminal_tab_pinned')
  expect(f.hasTab()).toBe(true)
})

it('preserves dormant SSH kill IDs when the acknowledged tab becomes headless', async () => {
  const f = fixture()
  const visible = 'ssh:target@@visible'
  const dormant = 'ssh:target@@persisted-only'
  f.store.persistPtyBinding({
    worktreeId: ACK_WORKTREE,
    tabId: ACK_TAB,
    leafId: ACK_LEAF,
    ptyId: visible,
    incarnationId: ACK_INCARNATION
  })
  f.store.setWorkspaceSession({
    ...f.store.getWorkspaceSession(),
    remoteSessionIdsByTabId: { [ACK_TAB]: dormant }
  })
  f.runtime.registerPty(visible, ACK_WORKTREE, 'target', {
    tabId: ACK_TAB,
    leafId: ACK_LEAF,
    incarnationId: ACK_INCARNATION
  })
  f.publish(true, 2)
  const kill = vi.fn(() => true)
  f.runtime.setPtyController({ write: () => true, kill, getForegroundProcess: async () => null })
  f.closeTerminalTab.mockImplementationOnce(async () => {
    f.entered.resolve()
    await f.acknowledgement.promise
  })
  const pending = f.close()
  await f.entered.promise
  f.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  f.acknowledgement.resolve()
  await expect(pending).resolves.toEqual({ closed: true })
  expect(kill.mock.calls).toEqual(expect.arrayContaining([[visible], [dormant]]))
  expect(f.hasTab()).toBe(false)
})

it('protects a persisted sibling omitted by a partial mobile snapshot', async () => {
  const f = fixture(true)
  f.publish(true, 2, [ACK_LEAF])
  const pending = f.close()
  await f.entered.promise
  f.runtime.onPtySpawned('pty-b', '66666666-6666-4666-8666-666666666666')
  f.acknowledgement.resolve()
  await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  expect(f.hasTab()).toBe(true)
})

it('never re-issues the renderer close against a successor that took the tab id', async () => {
  const f = fixture()
  const pending = f.close()
  await f.entered.promise
  const session = f.store.getWorkspaceSession()
  f.store.setWorkspaceSession(
    advanceTerminalTopologyRevision(
      {
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [ACK_WORKTREE]: session.tabsByWorktree[ACK_WORKTREE].map((tab) => ({
            ...tab,
            createdAt: 999
          }))
        }
      },
      ACK_WORKTREE
    )
  )
  f.acknowledgement.resolve()
  await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  // Why: notifier.closeTerminalTab carries only a tab id — no generation, PTY or
  // incarnation — so the renderer kills whatever occupies that id when it arrives.
  // Retrying the close after this refusal therefore destroys the successor, and
  // re-capturing identity beforehand cannot prevent it (it only detects a further
  // race). One call per close is what keeps the successor alive.
  expect(f.closeTerminalTab).toHaveBeenCalledTimes(1)
  expect(f.hasTab()).toBe(true)
})
