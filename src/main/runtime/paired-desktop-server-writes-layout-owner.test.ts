// Paired close uses session.tabs.close to stop host terminals; window-style layout.apply assumes its window already stopped them.
import { describe, expect, it, vi } from 'vitest'
import {
  LEAF_A,
  PTY_A,
  TAB_ID,
  WORKTREE_ID,
  setupMainOwnedWorkspace
} from './main-owned-workspace-runtime-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

type Fixture = ReturnType<typeof setupMainOwnedWorkspace>

const tabRow = (fixture: Fixture) =>
  fixture.session().tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === TAB_ID)

/** A server window whose renderer would answer the window-era relays; main must not use them. */
function withWindow(fixture: Fixture) {
  const notifier = {
    renameTerminal: vi.fn(),
    setPaneTitle: vi.fn(() => true)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these writes reach only these two notices.
  fixture.runtime.setNotifier(notifier as never)
  Object.assign(fixture.runtime, { getAvailableAuthoritativeWindow: () => ({ webContents: {} }) })
  return notifier
}

/** session.tabs.close as the desktop sends it: the host tab id, a user reason, no force. */
const desktopClose = (fixture: Fixture) =>
  fixture.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, {
    reason: 'user',
    clientNavigationId: 'paired-desktop'
  })

// This harness has no renderer publication, so only main-owned session rows exist.
describe('a paired desktop’s close of a tab a server’s main owns, with no window', () => {
  it('closes the tab in main’s layout and stops its terminal', async () => {
    const fixture = setupMainOwnedWorkspace()

    await desktopClose(fixture)

    expect(tabRow(fixture)).toBeUndefined()
    expect(fixture.stopped).toEqual([PTY_A])
  })

  it('refuses a pinned tab, keeping it and its terminal', async () => {
    const fixture = setupMainOwnedWorkspace({ pinned: true })

    await expect(desktopClose(fixture)).rejects.toThrow('terminal_tab_pinned')

    expect(tabRow(fixture)).toBeDefined()
    expect(fixture.stopped).toEqual([])
  })
})

describe.each([
  { name: 'no window', window: false },
  { name: 'a window', window: true }
])('a paired desktop’s write to a workspace a server’s main owns, with $name', (each) => {
  const setup = () => {
    const fixture = setupMainOwnedWorkspace()
    const notifier = each.window ? withWindow(fixture) : null
    return { fixture, notifier }
  }

  it('names the tab in main’s layout through terminal.rename', async () => {
    const { fixture, notifier } = setup()

    await fixture.runtime.renameTerminal(fixture.handleOf(PTY_A), 'from desktop')

    expect(tabRow(fixture)?.customTitle).toBe('from desktop')
    expect(notifier?.renameTerminal.mock.calls ?? []).toEqual([])
  })

  it('applies the routed props, chat pane and AI vault title in main, stopping nothing', async () => {
    const { fixture } = setup()

    for (const command of [
      { type: 'setTabProps', workspace: WORKTREE_ID, tabId: TAB_ID, color: '#ff0000' },
      { type: 'setChatPane', workspace: WORKTREE_ID, tabId: TAB_ID, leafId: LEAF_A },
      { type: 'renameTab', workspace: WORKTREE_ID, tabId: TAB_ID, kind: 'aiVault', title: null }
    ] as const) {
      await expect(fixture.runtime.applyLayoutCommand(command)).resolves.toMatchObject({ ok: true })
    }

    expect(tabRow(fixture)).toMatchObject({ color: '#ff0000' })
    expect(fixture.session().terminalLayoutsByTabId[TAB_ID]?.chatLeafId).toBe(LEAF_A)
    expect(fixture.stopped).toEqual([])
  })

  // The pitfall: a window's closeTabs means its window already stopped the terminals.
  it('takes a window-style layout.apply close as already stopped, so the terminal runs on', async () => {
    const { fixture } = setup()

    await fixture.runtime.applyLayoutCommand({
      type: 'closeTabs',
      workspace: WORKTREE_ID,
      tabIds: [TAB_ID],
      recordClose: 'user'
    })

    expect(tabRow(fixture)).toBeUndefined()
    expect(fixture.stopped).toEqual([])
  })
})
