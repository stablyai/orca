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
import { delegatedMobileSessionTabClose } from './mobile-session-tab-close-outcome'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

// Main-owned closes have no window ack; their counterparts live in acknowledged-terminal-tab-retirement-main-close.test.ts.
const itSwitchOff = it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)

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

itSwitchOff.each([false, true])(
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
    await expect(pending).resolves.toEqual({ closed: true, retirementConfirmed: true })
    expect(f.hasTab()).toBe(false)
  }
)

itSwitchOff.each(['createdAt', 'generation'] as const)(
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

itSwitchOff.each([false, true])(
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
    await f.runtime.onPtyExit('pty-a', 0, ACK_INCARNATION, { providerExitObserved: true })
    expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[ACK_TAB].ptyIdsByLeafId).toEqual({
      [ACK_SECOND_LEAF]: 'pty-b'
    })
    f.acknowledgement.resolve()
    await expect(pending).resolves.toEqual({ closed: true, retirementConfirmed: true })
    expect(f.hasTab()).toBe(false)
  }
)

itSwitchOff('protects a new incarnation admitted after the old snapshot disappeared', async () => {
  const f = fixture(true)
  const pending = f.close()
  await f.entered.promise
  f.publish(false, 2)
  f.runtime.onPtySpawned('pty-a', '66666666-6666-4666-8666-666666666666')
  f.acknowledgement.resolve()
  await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  expect(f.hasTab()).toBe(true)
})

itSwitchOff(
  'protects a persisted incarnation replacement on the same leaf and raw PTY ID',
  async () => {
    const f = fixture(true)
    const pending = f.close()
    await f.entered.promise
    await f.store.persistPtyBinding({
      worktreeId: ACK_WORKTREE,
      tabId: ACK_TAB,
      leafId: ACK_LEAF,
      ptyId: 'pty-a',
      incarnationId: '66666666-6666-4666-8666-666666666666'
    })
    f.acknowledgement.resolve()
    await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
    expect(f.hasTab()).toBe(true)
  }
)

itSwitchOff('rechecks current pins after renderer acknowledgement', async () => {
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
  await expect(f.store.flushPendingOrThrowAsync()).resolves.toBeUndefined()
})

it('keeps persistence writable when worktree teardown finds remaining terminal rows', async () => {
  const f = fixture()
  f.store.updateRepo({ id: 'repo1' }, { executionHostId: 'ssh:target' })
  f.store.setWorktreeMeta(hostWorktreeTarget({ id: ACK_WORKTREE, hostId: 'ssh:target' }), {
    hostId: 'ssh:target'
  })
  f.store.setWorkspaceSession(f.store.getWorkspaceSession(), 'ssh:target')
  vi.spyOn(f.runtime, 'closeMobileSessionTab').mockResolvedValue(delegatedMobileSessionTabClose())
  await expect(f.runtime.closeTerminalsForWorktree(`id:${ACK_WORKTREE}`)).rejects.toThrow(
    'terminal_close_incomplete'
  )
  expect(f.hasTab()).toBe(true)
  await expect(f.store.flushPendingOrThrowAsync()).resolves.toBeUndefined()
})

itSwitchOff(
  'preserves dormant SSH kill IDs when the acknowledged tab becomes headless',
  async () => {
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
    f.closeTerminalTab.mockImplementationOnce(async () => {
      f.entered.resolve()
      await f.acknowledgement.promise
    })
    const pending = f.close()
    await f.entered.promise
    f.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    f.acknowledgement.resolve()
    await expect(pending).resolves.toEqual({ closed: true, retirementConfirmed: true })
    expect(kill.mock.calls).toEqual(expect.arrayContaining([[visible], [dormant]]))
    expect(f.hasTab()).toBe(false)
  }
)

itSwitchOff('protects a persisted sibling omitted by a partial mobile snapshot', async () => {
  const f = fixture(true)
  f.publish(true, 2, [ACK_LEAF])
  const pending = f.close()
  await f.entered.promise
  f.runtime.onPtySpawned('pty-b', '66666666-6666-4666-8666-666666666666')
  f.acknowledgement.resolve()
  await expect(pending).resolves.toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  expect(f.hasTab()).toBe(true)
})

itSwitchOff(
  'never re-issues the renderer close against a successor that took the tab id',
  async () => {
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
    // Tab-only close notices lack generation identity; retrying after refusal could kill the successor, even after recapture.
    expect(f.closeTerminalTab).toHaveBeenCalledTimes(1)
    expect(f.hasTab()).toBe(true)
  }
)
