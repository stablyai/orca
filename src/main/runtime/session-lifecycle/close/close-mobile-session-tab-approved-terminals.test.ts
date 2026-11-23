import { describe, expect, it, vi } from 'vitest'
import {
  setupMainOwnedWorkspace,
  LEAF_A,
  PTY_A,
  PTY_B,
  TAB_ID,
  WORKTREE_ID
} from '../../terminal/layout/main-owned-workspace-runtime-fixture'
import {
  ACK_TAB,
  ACK_WORKTREE,
  createAcknowledgedTabRetirementFixture
} from '../../session-tabs/terminal-retirement/acknowledged-terminal-tab-retirement-fixture'

const NEW_LEAF = '33333333-3333-4333-8333-333333333333'

async function setup(opts?: { split?: boolean }) {
  const fixture = await setupMainOwnedWorkspace(opts)
  const stopped: string[] = []
  fixture.runtime.setPtyController({
    write: () => true,
    kill: (ptyId: string) => stopped.push(ptyId) > 0,
    stopAndWait: async (ptyId: string) => stopped.push(ptyId) > 0,
    getForegroundProcess: async () => null
  })
  const approved = [fixture.handleOf(PTY_A)]
  return { fixture, stopped, approved }
}

describe('closing a tab for approved terminals', () => {
  it('refuses and stops nothing when a split terminal arrived after snapshot publication', async () => {
    const { fixture, stopped, approved } = await setup()
    // Cache snapshot before the new pane arrives in main layout.
    await fixture.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    await fixture.runtime.applyLayoutCommand({
      type: 'splitPane',
      workspace: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_A,
      direction: 'vertical',
      newLeafId: NEW_LEAF
    })
    fixture.runtime.registerPty('pty-new', WORKTREE_ID, null, { tabId: TAB_ID, leafId: NEW_LEAF })
    fixture.bindPaneTerminal(NEW_LEAF, 'pty-new')

    const result = await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
      reason: 'user',
      approvedTerminalHandles: approved
    })

    expect(result).toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
    expect(stopped).toEqual([])
  })

  it('refuses and stops nothing when a replacement terminal bound in main layout before snapshot republish', async () => {
    const { fixture, stopped, approved } = await setup()
    await fixture.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    fixture.runtime.registerPty('pty-replacement', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_A
    })
    fixture.bindPaneTerminal(LEAF_A, 'pty-replacement')

    const result = await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
      reason: 'user',
      approvedTerminalHandles: approved
    })

    expect(result).toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
    expect(stopped).toEqual([])
  })

  it('refuses when an empty approval meets a live terminal on the host', async () => {
    const { fixture, stopped } = await setup()

    const result = await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
      reason: 'user',
      approvedTerminalHandles: []
    })

    expect(result).toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
    expect(stopped).toEqual([])
  })

  it('ignores disconnected sibling PTY records so an exited pane does not block closing', async () => {
    const { fixture, stopped, approved } = await setup({ split: true })
    const exitedSibling = fixture.ptyRecord(PTY_B)
    expect(exitedSibling).toBeDefined()
    exitedSibling!.connected = false

    const result = await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
      reason: 'user',
      approvedTerminalHandles: approved
    })

    expect(result.refused).toBeUndefined()
    expect(stopped).toContain(PTY_A)
  })

  it('refuses an unforced close of a newly pinned tab even on legacy closeTerminal notifiers', async () => {
    const fixture = await createAcknowledgedTabRetirementFixture(true)
    try {
      const listed = await fixture.runtime.listMobileSessionTabs(`id:${ACK_WORKTREE}`)
      const approved = listed.tabs.flatMap((tab) =>
        tab.type === 'terminal' && tab.parentTabId === ACK_TAB && tab.terminal ? [tab.terminal] : []
      )
      const session = fixture.store.getWorkspaceSession()
      fixture.store.setWorkspaceSession({
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [ACK_WORKTREE]: session.tabsByWorktree[ACK_WORKTREE].map((tab) =>
            tab.id === ACK_TAB ? { ...tab, isPinned: true } : tab
          )
        }
      })
      await fixture.publish(true, 2)

      const legacyCloseTerminal = vi.fn()
      fixture.runtime.setNotifier({
        closeTerminal: legacyCloseTerminal,
        worktreesChanged: () => {},
        reposChanged: () => {},
        activateWorktree: () => {},
        createTerminal: () => {},
        splitTerminal: () => {},
        renameTerminal: () => {},
        focusTerminal: () => {},
        terminalFitOverrideChanged: () => {},
        terminalDriverChanged: () => {}
      })

      await expect(
        fixture.runtime.closeMobileSessionTab(`id:${ACK_WORKTREE}`, ACK_TAB, {
          reason: 'user',
          approvedTerminalHandles: approved
        })
      ).rejects.toThrow('terminal_tab_pinned')
      expect(legacyCloseTerminal).not.toHaveBeenCalled()
    } finally {
      await fixture.dispose()
    }
  })

  it('stops the approved terminal when nothing changed', async () => {
    const { fixture, stopped, approved } = await setup()

    const result = await fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
      reason: 'user',
      approvedTerminalHandles: approved
    })

    expect(result.refused).toBeUndefined()
    expect(stopped).toEqual([PTY_A])
  })
})
