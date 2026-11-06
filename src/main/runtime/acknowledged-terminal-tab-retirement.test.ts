import { afterEach, expect, it, vi } from 'vitest'
import {
  ACK_LEAF,
  ACK_TAB,
  ACK_WORKTREE,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'
import { advanceTerminalTopologyRevision } from '../persistence/terminal-topology/terminal-topology-membership'
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
