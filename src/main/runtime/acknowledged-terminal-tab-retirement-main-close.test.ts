// Layout-owner build twins of acknowledged-terminal-tab-retirement.test.ts: a phone's close of a tab
// main owns is one layout write main makes itself, so no window acknowledgement is awaited and no
// state can change between a window's ack and the commit. Each case is that file's scenario.
import { afterEach, expect, it, vi } from 'vitest'
import {
  ACK_INCARNATION,
  ACK_LEAF,
  ACK_SECOND_LEAF,
  ACK_TAB,
  ACK_WORKTREE,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'
import { advanceTerminalTopologyRevision } from '../persistence/terminal-topology/terminal-topology-membership'
import { _resetClosedPaneFencesForTests } from '../persistence/terminal-topology/closed-pane-binding-fence'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const fixtures: ReturnType<typeof createAcknowledgedTabRetirementFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
  vi.restoreAllMocks()
  // Every case reuses the fixture's tab id, which an earlier case's close fenced in this process.
  _resetClosedPaneFencesForTests()
})
function fixture(bound = false) {
  const result = createAcknowledgedTabRetirementFixture(bound)
  fixtures.push(result)
  // Every stop main asks for, so a case can name the terminals its close ended.
  const stopped: string[] = []
  result.runtime.setPtyController({
    write: () => true,
    kill: (ptyId: string) => {
      stopped.push(ptyId)
      return true
    },
    getForegroundProcess: async () => null
  })
  return { ...result, stopped }
}

it.each([false, true])(
  'durably closes the row in main without the window, graph republished first=%s',
  async (graphFirst) => {
    const f = fixture()
    if (graphFirst) {
      f.publish(false, 2)
    }
    await expect(f.close()).resolves.toEqual({ closed: true })
    expect(f.hasTab()).toBe(false)
    expect(f.closeTerminalTab).not.toHaveBeenCalled()
    await f.store.flushPendingOrThrowAsync()
    expect(f.readDisk().workspaceSession?.tabsByWorktree?.[ACK_WORKTREE] ?? []).toEqual([])
  }
)

it.each(['createdAt', 'generation'] as const)(
  'closes the tab main holds now after a same-ID replacement with newer %s',
  async (field) => {
    const f = fixture()
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
    await expect(f.close()).resolves.toEqual({ closed: true })
    expect(f.hasTab()).toBe(false)
  }
)

it.each([false, true])(
  'closes a split after one pane exited, with remote-session promotion=%s',
  async (remoteSession) => {
    const f = fixture(true)
    if (remoteSession) {
      f.store.setWorkspaceSession({
        ...f.store.getWorkspaceSession(),
        remoteSessionIdsByTabId: { [ACK_TAB]: 'pty-a' }
      })
    }
    await f.runtime.onPtyExit('pty-a', 0, ACK_INCARNATION, { providerExitObserved: true })
    await expect(f.close()).resolves.toEqual({ closed: true })
    expect(f.hasTab()).toBe(false)
    expect(f.stopped).toContain('pty-b')
  }
)

it('closes a pane whose new incarnation main admitted, and stops that terminal', async () => {
  const f = fixture(true)
  f.runtime.onPtySpawned('pty-a', '66666666-6666-4666-8666-666666666666')
  await expect(f.close()).resolves.toEqual({ closed: true })
  expect(f.hasTab()).toBe(false)
  expect(f.stopped).toEqual(expect.arrayContaining(['pty-a', 'pty-b']))
})

it('closes on the incarnation main persisted for the leaf', async () => {
  const f = fixture(true)
  await f.store.persistPtyBinding({
    worktreeId: ACK_WORKTREE,
    tabId: ACK_TAB,
    leafId: ACK_LEAF,
    ptyId: 'pty-a',
    incarnationId: '66666666-6666-4666-8666-666666666666'
  })
  await expect(f.close()).resolves.toEqual({ closed: true })
  expect(f.hasTab()).toBe(false)
})

it("stops a sibling a partial mobile snapshot omitted, from main's own panes", async () => {
  const f = fixture(true)
  f.publish(true, 2, [ACK_LEAF])
  await expect(f.close()).resolves.toEqual({ closed: true })
  expect(f.stopped).toEqual(expect.arrayContaining(['pty-a', 'pty-b']))
  expect(
    f.store.getWorkspaceSession().terminalLayoutsByTabId[ACK_TAB]?.ptyIdsByLeafId?.[ACK_SECOND_LEAF]
  ).toBeUndefined()
})

it('refuses a tab pinned before the close and keeps it', async () => {
  const f = fixture()
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
  await expect(f.close()).rejects.toThrow('terminal_tab_pinned')
  expect(f.hasTab()).toBe(true)
  await expect(f.store.flushPendingOrThrowAsync()).resolves.toBeUndefined()
})

it('stops the visible and the dormant SSH terminal of the closed tab', async () => {
  const f = fixture()
  const visible = 'ssh:target@@visible'
  const dormant = 'ssh:target@@persisted-only'
  await f.store.persistPtyBinding({
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
  await expect(f.close()).resolves.toEqual({ closed: true })
  expect(kill.mock.calls).toEqual(expect.arrayContaining([[visible], [dormant]]))
  expect(f.hasTab()).toBe(false)
})

// Twin of terminal-retirement-async-durability.test.ts's acknowledged close: main's own close
// answers only once its layout write is durable, as the window-era close waited for its retirement.
it("answers the close only once main's layout write is durable", async () => {
  const f = fixture(true)
  await f.store.flushPendingOrThrowAsync()
  const gate = f.authority.pause()
  let answered = false
  const closing = f.close().then((result) => {
    answered = true
    return result
  })
  await gate.started.promise
  expect(answered).toBe(false)
  gate.finish.resolve()
  await expect(closing).resolves.toEqual({ closed: true })
  expect(f.hasTab()).toBe(false)
})
